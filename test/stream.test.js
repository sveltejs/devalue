import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import { unevalStream } from '../index.js';
import { client, drain } from './helpers/stream.js';

describe('unevalStream', () => {

	function null_prototype_callable(callback) {
		return Object.setPrototypeOf(callback, null);
	}

	const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

	async function rejects(promise, match) {
		let error;
		let did_reject = false;
		try {
			await promise;
		} catch (caught) {
			did_reject = true;
			error = caught;
		}
		expect(did_reject).toBe(true);
		if (match instanceof RegExp) expect(error.message).toMatch(match);
		else if (match !== undefined) expect(error).toBe(match);
		return error;
	}

	test('serializes synchronous primitives and graphs', async () => {
		const cycle = { value: 1 };
		cycle.self = cycle;
		const { root, blocks } = await drain(await unevalStream({ cycle, repeated: cycle }));
		expect(root.cycle).toBe(root.repeated);
		expect(root.cycle.self).toBe(root.cycle);
		expect(blocks).toEqual([]);
	});

	test('preserves object key order across deferred construction in head and tail regions', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}

		const create_graph = (region) => {
			const self = {};
			self.self = self;
			self['later key'] = `${region}-self`;

			const left = {};
			const right = {};
			left.peer = right;
			left.label = `${region}-left`;
			right.owner = left;
			right.label = `${region}-right`;

			const mixed = {};
			mixed.wrapper = new Wrapper(mixed);
			mixed['after wrapper'] = `${region}-mixed`;

			const repeated = {};
			repeated.first = region;
			repeated.self = repeated;
			repeated['non identifier'] = true;

			const numeric = {};
			numeric.tail = region;
			numeric[10] = numeric;
			numeric[2] = 'two';
			numeric.after = true;

			const null_object = Object.create(null);
			null_object.self = null_object;
			null_object['null key'] = region;

			return { self, left, mixed, repeated: [repeated, repeated], numeric, null_object };
		};
		const expected = {
			self: ['self', 'later key'],
			left: ['peer', 'label'],
			right: ['owner', 'label'],
			mixed: ['wrapper', 'after wrapper'],
			repeated: ['first', 'self', 'non identifier'],
			numeric: ['2', '10', 'tail', 'after'],
			null_object: ['self', 'null key']
		};
		const verify = (graph) => {
			expect(Object.keys(graph.self)).toEqual(expected.self);
			expect(graph.self.self).toBe(graph.self);
			expect(Object.keys(graph.left)).toEqual(expected.left);
			expect(Object.keys(graph.left.peer)).toEqual(expected.right);
			expect(graph.left.peer.owner).toBe(graph.left);
			expect(Object.keys(graph.mixed)).toEqual(expected.mixed);
			expect(graph.mixed.wrapper.value).toBe(graph.mixed);
			expect(graph.repeated[0]).toBe(graph.repeated[1]);
			expect(Object.keys(graph.repeated[0])).toEqual(expected.repeated);
			expect(graph.repeated[0].self).toBe(graph.repeated[0]);
			expect(Object.keys(graph.numeric)).toEqual(expected.numeric);
			expect(graph.numeric[10]).toBe(graph.numeric);
			expect(Object.getPrototypeOf(graph.null_object)).toBe(null);
			expect(Object.keys(graph.null_object)).toEqual(expected.null_object);
			expect(graph.null_object.self).toBe(graph.null_object);
		};
		const replacer = (value, js) => value instanceof Wrapper && js`({value:${value.value}})`;

		const pending = Promise.withResolvers();
		const result = await unevalStream({ head: create_graph('head'), tail: pending.promise }, replacer, { id: 'object-order' });
		const target = client();
		const root = target.head(result.head);
		verify(root.head);
		pending.resolve(create_graph('tail'));
		for await (const block of result.tail) target.block(block);
		verify(await root.tail);
	});

	test('no async values create no client session', async () => {
		const target = client();
		const result = await unevalStream({ value: 1 });
		expect({ ...target.head(result.head) }).toEqual({ value: 1 });
		expect(target.context.__d).toBe(undefined);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('preserves sparse arrays, maps, sets, buffers, and views', async () => {
		const array = Array(8);
		array[3] = 'x';
		const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
		const view = new Uint16Array(buffer, 0, 2);
		const key = {};
		const { root } = await drain(await unevalStream({ array, map: new Map([[key, view]]), set: new Set([key]), buffer }));
		expect(root.array.length).toBe(8);
		expect(!(0 in root.array)).toBeTruthy();
		expect(root.array[3]).toBe('x');
		const revived_key = Array.from(root.map.keys())[0];
		expect(Array.from(root.set)[0]).toBe(revived_key);
		expect(root.map.get(revived_key).buffer).toBe(root.buffer);
	});

	test('preserves identity from head into a promise outcome', async () => {
		const pending = Promise.withResolvers();
		const shared = { value: 1 };
		const result = await unevalStream({ shared, pending: pending.promise }, undefined, { id: 'head-tail' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(shared);
		const next = await result.tail.next();
		target.block(next.value);
		expect(await root.pending).toBe(root.shared);
	});

	test('preserves identity between separate promise outcomes', async () => {
		const a = Promise.withResolvers();
		const b = Promise.withResolvers();
		const shared = { value: 1 };
		const result = await unevalStream([a.promise, b.promise], undefined, { id: 'tail-tail' });
		const target = client();
		const root = target.head(result.head);
		a.resolve(shared);
		b.resolve(shared);
		for await (const block of result.tail) target.block(block);
		expect(await root[0]).toBe(await root[1]);
	});

	test('keeps descending overlapping roots and duplicate ordinary holes lowered once and in order', async () => {
		const ready = Promise.withResolvers();
		const job = {};
		const r1 = { value: 42 };
		const r2 = { child: r1 };
		let constructions = 0;
		const result = await unevalStream({ job }, (value, js) => value === job && ({
			type: 'async-value',
			source: ready.promise,
			construct: () => {
				constructions++;
				return js`({value:null,also:null,dup:null,again:null})`;
			},
			// The parent root precedes its child root (descending), and r1 plus r2 are
			// each repeated: duplicates must reuse one eager local, not re-anchor.
			resolve: ({ target }) => js`${target}.value=${r2};${target}.also=${r1};${target}.dup=${r1};${target}.again=${r2}`,
			reject: () => js``
		}), { id: 'descriptor-descending-holes' });
		const target = client();
		const root = target.head(result.head);
		const data = target.context.__d['descriptor-descending-holes'];
		const initial = data.a.length;
		ready.resolve(1);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(constructions).toBe(1);
		expect(data.a.length).toBe(initial + 1);
		expect((block.match(/\.a\[\d+\]=/g) ?? []).length).toEqual(1);
		expect(root.job.value).toBe(root.job.again);
		expect(root.job.also).toBe(root.job.dup);
		expect(root.job.value.child).toBe(root.job.dup);
		expect(root.job.value.child).toBe(root.job.also);
		expect(root.job.value.child.value).toBe(42);
	});

	test('reuses ordinary descriptor holes across same and later events with a later shorter retained path', async () => {
		const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
		const leaf = { value: 1 };
		const deep = { veryLongPropertyName: { anotherLongPropertyName: leaf } };
		const result = await unevalStream(
			{ deep, first: gates[0].promise, second: gates[1].promise, third: gates[2].promise },
			(value, js) => {
				const index = [gates[0].promise, gates[1].promise, gates[2].promise].indexOf(value);
				if (index === -1) return;
				const operations = [
					({ target }) => js`${target}.a=${leaf}`,
					({ target }) => js`${target}.b=${leaf};${target}.c=${leaf}`,
					({ target }) => js`${target}.value=${leaf}`
				];
				return {
					type: 'async-value',
					source: value,
					construct: () => js`({value:null})`,
					resolve: operations[index],
					reject: () => js``
				};
			},
			{ id: 'ordinary-descriptor-reuse' }
		);
		const target = client();
		const root = target.head(result.head);
		const data = target.context.__d['ordinary-descriptor-reuse'];
		const initial = data.a.length;
		gates[0].resolve(1);
		gates[1].resolve(2);
		const first_block = (await result.tail.next()).value;
		target.block(first_block);
		expect(data.s.length).toBe(1);
		expect((first_block.match(/\.s\[0\]/g) ?? []).length >= 2, first_block).toBeTruthy();
		expect((first_block.match(/\.veryLongPropertyName\.anotherLongPropertyName/g) ?? []).length).toEqual(1);
		gates[2].resolve(3);
		const second_block = (await result.tail.next()).value;
		target.block(second_block);
		expect(second_block).toMatch(/\.s\[0\]/);
		expect(second_block).not.toMatch(/veryLongPropertyName|anotherLongPropertyName/);
		const revived = root.deep.veryLongPropertyName.anotherLongPropertyName;
		expect(root.first.a).toBe(revived);
		expect(root.second.b).toBe(revived);
		expect(root.second.c).toBe(revived);
		expect(root.third.value).toBe(revived);
		expect(revived.value).toBe(1);
		expect(data.a.length).toBe(initial);
		await result.tail.return();
	});

	test('preserves same-batch identities without reading paths before their event exists', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}
		for (const staggered of [false, true]) {
			const first = Promise.withResolvers();
			const second = Promise.withResolvers();
			const third = Promise.withResolvers();
			const child = { value: staggered ? 'staggered' : 'batched' };
			const result = await unevalStream(
				{ first: first.promise, second: second.promise, third: third.promise },
				(value, js) => value instanceof Wrapper && js`({wrapped:${value.value}})`,
				{ id: `ordered-${staggered}` }
			);
			const target = client();
			const root = target.head(result.head);
			first.resolve({
				long_property_one: { long_property_two: { child } },
				collection: new Map([[child, 'child']]),
				opaque: new Wrapper(child)
			});
			if (staggered) {
				// awaiting the delivered block keeps the first settlement in its own batch
				target.block((await result.tail.next()).value);
			}
			second.resolve(child);
			third.resolve(child);
			for await (const block of result.tail) target.block(block);
			const introduced = await root.first;
			const a = await root.second;
			const b = await root.third;
			expect(a).toBe(b);
			expect(a).toBe(introduced.long_property_one.long_property_two.child);
			expect(a).toBe(Array.from(introduced.collection.keys())[0]);
			expect(a).toBe(introduced.opaque.wrapped);
		}
	});

	test('materializes custom operation payloads once before ignored lazy conditional and repeated uses', async () => {
		class Job {
			constructor(kind) {
				this.kind = kind;
				this.ready = Promise.withResolvers();
			}
		}
		class Payload {}
		const jobs = ['ignored', 'lazy', 'conditional', 'repeated'].map((kind) => new Job(kind));
		const shared = Promise.withResolvers();
		const payload = new Payload();
		const replacer = (value, js) => {
			if (value instanceof Payload) return js`(globalThis.constructions++,{payload:true})`;
			if (!(value instanceof Job)) return;
			return {
				type: 'async-value',
				// Descriptor fields cannot spoof the private immediate-adapter provenance.
				immediate: true,
				source: value.ready.promise,
				construct: () => js`({kind:${value.kind}})`,
				resolve: ({ target }, outcome) => {
					if (value.kind === 'ignored') return js``;
					if (value.kind === 'lazy') return js`${target}.get=()=>${outcome}`;
					if (value.kind === 'conditional') return js`if(false){${target}.value=${outcome}}`;
					return js`${target}.values=[${outcome},${outcome}]`;
				},
				reject: () => js``
			};
		};
		const result = await unevalStream(
			{ ignored: jobs[0], lazy: jobs[1], conditional: jobs[2], repeated: jobs[3], shared: shared.promise },
			replacer,
			{ id: 'materialized-custom' }
		);
		const target = client({ constructions: 0 });
		const root = target.head(result.head);
		for (const job of jobs) job.ready.resolve(payload);
		shared.resolve(payload);
		for await (const block of result.tail) target.block(block);
		const revived = await root.shared;
		expect(target.context.constructions).toBe(1);
		expect(root.conditional.value).toBe(undefined);
		expect(root.repeated.values[0]).toBe(revived);
		expect(root.repeated.values[0]).toBe(root.repeated.values[1]);
		expect(root.lazy.get()).toBe(revived);
		expect(root.lazy.get()).toBe(revived);
	});

	test('passes one materialized fallback Error to every repeated fallback use', async () => {
		class Job {}
		const ready = Promise.withResolvers();
		const result = await unevalStream(new Job(), (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: ready.promise,
			construct: () => js`({errors:[]})`,
			resolve: () => { throw new Error('generation failed'); },
			reject: ({ target }, error) => js`${target}.errors=[${error},${error}]`
		}), { id: 'fallback-identity' });
		const target = client();
		const root = target.head(result.head);
		ready.resolve({ unused: true });
		for await (const block of result.tail) target.block(block);
		expect(root.errors[0]).toBe(root.errors[1]);
		expect(root.errors[0].message).toMatch(/failed to serialize asynchronous value/);
	});

	test('recognizes only branded native promises across realms and subclasses', async () => {
		const foreign = vm.runInNewContext('Promise.resolve(2)');
		class SubPromise extends Promise {}
		const values = [Promise.resolve(1), foreign, SubPromise.resolve(3)];
		const { root } = await drain(await unevalStream(values, undefined, { id: 'promise-brands' }));
		expect(await Promise.all(Array.from(root))).toEqual([1, 2, 3]);

		const spoof = { [Symbol.toStringTag]: 'Promise', then() {} };
		await rejects(unevalStream(spoof), /Cannot stringify/);
	});

	test('preserves serializable rejection reason identity across regions', async () => {
		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		const reason = { message: 'shared' };
		const result = await unevalStream({ reason, first: first.promise, second: second.promise }, undefined, { id: 'reason-identity' });
		const target = client();
		const root = target.head(result.head);
		first.reject(reason);
		target.block((await result.tail.next()).value);
		let first_reason;
		try { await root.first; } catch (error) { first_reason = error; }
		second.reject(reason);
		target.block((await result.tail.next()).value);
		let second_reason;
		try { await root.second; } catch (error) { second_reason = error; }
		expect(first_reason).toBe(root.reason);
		expect(second_reason).toBe(root.reason);
	});

	test('collects ordered settlements until the ready batch is consumed', async () => {
		const a = Promise.withResolvers();
		const b = Promise.withResolvers();
		const result = await unevalStream([a.promise, b.promise], undefined, { id: 'ready-until-consumed' });
		const target = client();
		const root = target.head(result.head);
		const first_settled = Promise.withResolvers();
		const second_settled = Promise.withResolvers();
		queueMicrotask(() => {
			a.resolve('first');
			first_settled.resolve();
		});
		await first_settled.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		queueMicrotask(() => {
			b.resolve('second');
			second_settled.resolve();
		});
		await second_settled.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));
		const first = await result.tail.next();
		const second = await result.tail.next();
		expect(!first.done && second.done).toBeTruthy();
		target.block(first.value);
		expect(await Promise.all(Array.from(root))).toEqual(['first', 'second']);
	});

	test('rejects an unserializable asynchronous fulfillment', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'invalid' });
		const target = client();
		const root = target.head(result.head);
		const rejected = rejects(root, /failed to serialize asynchronous value/);
		pending.resolve(() => {});
		const block = await result.tail.next();
		target.block(block.value);
		await rejected;
	});

	test('rolls back nested async values from a failed event', async () => {
		const pending = Promise.withResolvers();
		const nested = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'rollback' });
		const target = client();
		const root = target.head(result.head);
		const rejected = rejects(root);
		pending.resolve({ nested: nested.promise, invalid: () => {} });
		const block = await result.tail.next();
		target.block(block.value);
		await rejected;
		nested.resolve(1);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('rolls back provisional source state without touching its lifecycle', async () => {
		const outer = Promise.withResolvers();
		const nested = Promise.withResolvers();
		let then_reads = 0;
		let cancels = 0;
		class Job {}
		const job = new Job();
		const source = { get then() { then_reads++; return nested.promise.then.bind(nested.promise); } };
		const replacer = (value, js) => value === job && ({
			type: 'async-value', source, construct: () => js`({})`,
			resolve: () => js``, reject: () => js``,
			cancel() { cancels++; return Promise.reject(new Error('cleanup')); }
		});
		const result = await unevalStream(outer.promise, replacer, { id: 'transaction-rollback' });
		const target = client();
		const root = target.head(result.head);
		const rejected = rejects(root);
		outer.resolve({ job, invalid: () => {} });
		target.block((await result.tail.next()).value);
		await rejected;
		await delay();
		expect(then_reads).toBe(0);
		expect(cancels).toBe(0);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('preserves map key identity through a collection sidecar', async () => {
		const pending = Promise.withResolvers();
		const key = {};
		const result = await unevalStream({ map: new Map([[key, 1]]), pending: pending.promise }, undefined, { id: 'map' });
		expect(result.head).not.toMatch(/Array\.from\(/);
		const target = client();
		const root = target.head(result.head);
		pending.resolve(key);
		const block = await result.tail.next();
		expect(block.value).not.toMatch(/Array\.from\(/);
		target.block(block.value);
		expect(await root.pending).toBe(Array.from(root.map.keys())[0]);
	});

	test('preserves set member identity through a collection sidecar', async () => {
		const pending = Promise.withResolvers();
		const member = {};
		const result = await unevalStream({ set: new Set([member]), pending: pending.promise }, undefined, { id: 'set' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(member);
		target.block((await result.tail.next()).value);
		expect(await root.pending).toBe(Array.from(root.set)[0]);
	});

	test('retains descendants of Map key value and Set member sidecars', async () => {
		const pending_key = Promise.withResolvers();
		const pending_value = Promise.withResolvers();
		const pending_member = Promise.withResolvers();
		const key_child = { position: 'key' };
		const value_child = { position: 'value' };
		const member_child = { position: 'member' };
		const key = { nested: [key_child] };
		const value = { nested: { child: value_child } };
		const member = { nested: [member_child] };
		const result = await unevalStream({
			map: new Map([[key, value]]),
			set: new Set([member]),
			pending_key: pending_key.promise,
			pending_value: pending_value.promise,
			pending_member: pending_member.promise
		}, undefined, { id: 'collection-descendants' });
		const target = client();
		const root = target.head(result.head);
		pending_key.resolve(key_child);
		pending_value.resolve(value_child);
		pending_member.resolve(member_child);
		let emitted = result.head;
		for await (const block of result.tail) {
			emitted += block;
			target.block(block);
		}
		const revived_key = Array.from(root.map.keys())[0];
		const revived_value = root.map.get(revived_key);
		const revived_member = Array.from(root.set)[0];
		expect(await root.pending_key).toBe(revived_key.nested[0]);
		expect(await root.pending_value).toBe(revived_value.nested.child);
		expect(await root.pending_member).toBe(revived_member.nested[0]);
		expect((result.head.match(/\.c\[\d+\]=/g) ?? []).length, result.head).toBe(2);
		expect(emitted).not.toMatch(/\.s\[/);
		expect(emitted).not.toMatch(/Array\.from\(/);
	});

	test('retains collection descendants introduced before repeated outcomes in the same and later batches', async () => {
		const introduced = Promise.withResolvers();
		const same_a = Promise.withResolvers();
		const same_b = Promise.withResolvers();
		const later = Promise.withResolvers();
		const shared = { value: 1 };
		const key = { nested: [shared] };
		const value = { nested: { shared } };
		const member = { nested: [shared] };
		const result = await unevalStream({
			introduced: introduced.promise,
			same_a: same_a.promise,
			same_b: same_b.promise,
			later: later.promise
		}, undefined, { id: 'outcome-collection-descendants' });
		const target = client();
		const root = target.head(result.head);
		introduced.resolve({ map: new Map([[key, value]]), set: new Set([member]) });
		same_a.resolve(shared);
		same_b.resolve(shared);
		const first = (await result.tail.next()).value;
		expect(first).not.toMatch(/\.s\[/);
		target.block(first);
		const collection = await root.introduced;
		const revived_key = Array.from(collection.map.keys())[0];
		const revived_value = collection.map.get(revived_key);
		const revived_member = Array.from(collection.set)[0];
		expect(await root.same_a).toBe(revived_key.nested[0]);
		expect(await root.same_a).toBe(revived_value.nested.shared);
		expect(await root.same_a).toBe(revived_member.nested[0]);
		expect(await root.same_b).toBe(await root.same_a);
		expect(target.context.__d['outcome-collection-descendants'].a.length).toBe(2);
		later.resolve(shared);
		target.block((await result.tail.next()).value);
		expect(await root.later).toBe(await root.same_a);
	});

	test('uses a retained collection descendant as a custom async target', async () => {
		class Task {
			constructor() {
				this.ready = Promise.withResolvers();
			}
		}
		const task = new Task();
		const holder = { nested: [task] };
		const result = await unevalStream(
			new Set([holder]),
			(value, js) => value instanceof Task && ({
				type: 'async-value',
				source: value.ready.promise,
				construct: () => js`({value:void 0})`,
				resolve: ({ target }, payload) => js`${target}.value=${payload}`,
				reject: ({ target }, reason) => js`${target}.error=${reason}`
			}),
			{ id: 'collection-async-target' }
		);
		const target = client();
		const root = target.head(result.head);
		const payload = { ready: true };
		task.ready.resolve(payload);
		target.block((await result.tail.next()).value);
		const revived_task = Array.from(root)[0].nested[0];
		expect({ ...revived_task.value }).toEqual(payload);
	});

	test('retains cyclic shared view and buffer descendants without blanket slots', async () => {
		const pending_shared = Promise.withResolvers();
		const pending_view = Promise.withResolvers();
		const pending_buffer = Promise.withResolvers();
		const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
		const view = new Uint16Array(buffer);
		const shared = { value: 1 };
		const set = new Set();
		const holder = { collection: set, nested: [shared, view] };
		holder.self = holder;
		set.add(holder);
		const map_value = { nested: [shared] };
		const result = await unevalStream({
			set,
			map: new Map([[holder, map_value]]),
			primitive_set: new Set([1, 'two']),
			primitive_map: new Map([['one', 1], ['two', 2]]),
			pending_shared: pending_shared.promise,
			pending_view: pending_view.promise,
			pending_buffer: pending_buffer.promise
		}, undefined, { id: 'collection-mixed-descendants' });
		const target = client();
		const root = target.head(result.head);
		pending_shared.resolve(shared);
		pending_view.resolve(view);
		pending_buffer.resolve(buffer);
		let emitted = result.head;
		for await (const block of result.tail) {
			emitted += block;
			target.block(block);
		}
		const revived_holder = Array.from(root.set)[0];
		const revived_map_value = root.map.get(revived_holder);
		expect(revived_holder.self).toBe(revived_holder);
		expect(revived_holder.collection).toBe(root.set);
		expect(Array.from(root.map.keys())[0]).toBe(revived_holder);
		expect(await root.pending_shared).toBe(revived_holder.nested[0]);
		expect(await root.pending_shared).toBe(revived_map_value.nested[0]);
		expect(await root.pending_view).toBe(revived_holder.nested[1]);
		expect(await root.pending_buffer).toBe(revived_holder.nested[1].buffer);
		expect(Array.from(root.primitive_set)).toEqual([1, 'two']);
		expect(Array.from(root.primitive_map.keys())).toEqual(['one', 'two']);
		expect(root.primitive_map.get('one')).toBe(1);
		expect(root.primitive_map.get('two')).toBe(2);
		expect((result.head.match(/\.c\[\d+\]=/g) ?? []).length, result.head).toBe(2);
		expect(emitted).not.toMatch(/\.s\[/);
		expect(emitted).not.toMatch(/Array\.from\(/);
	});

	test('preserves a typed view backing buffer across regions', async () => {
		const pending = Promise.withResolvers();
		const view = new Uint8Array([1, 2]);
		const result = await unevalStream({ view, pending: pending.promise }, undefined, { id: 'buffer' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(view.buffer);
		target.block((await result.tail.next()).value);
		expect(await root.pending).toBe(root.view.buffer);
	});

	test('preserves custom child identity from the shared replacer session', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const shared = {};
		let calls = 0;
		const result = await unevalStream(
			{ shared, wrapped: new Wrapper(shared) },
			(value, js) => {
				if (!(value instanceof Wrapper)) return;
				calls++;
				return js`({value:${value.value}})`;
			}
		);
		const { root } = await drain(result);
		expect(calls).toBe(1);
		expect(root.shared).toBe(root.wrapped.value);
	});

	test('retains overlapping opaque descendants across root orders and availability boundaries', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}
		class Job {
			constructor() {
				this.ready = Promise.withResolvers();
			}
		}
		for (const reverse of [false, true]) {
			for (const streaming of [false, true]) {
				const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
				const view = new Uint16Array(buffer);
				const sparse = Array(4);
				const null_object = Object.create(null);
				const leaf = { label: 'leaf', sparse, null_object, view, buffer };
				leaf.self = leaf;
				sparse[2] = leaf;
				null_object.leaf = leaf;
				let node = leaf;
				const nodes = [];
				for (let i = 0; i < 12; i++) {
					nodes.push(node);
					node = { child: node };
				}
				const wrappers = nodes.map((value) => new Wrapper(value));
				if (reverse) wrappers.reverse();
				const index_by_node = new Map(nodes.map((value, index) => [value, index]));
				const pending = streaming ? Promise.withResolvers() : undefined;
				const later = streaming ? Promise.withResolvers() : undefined;
				const job = streaming ? new Job() : undefined;
				const input = streaming ? { wrappers, pending: pending.promise, later: later.promise, job } : { wrappers };
				const result = await unevalStream(input, (value, js) => {
					if (value instanceof Wrapper) return js`({value:${value.value}})`;
					if (value instanceof Job) return {
						type: 'async-value',
						source: value.ready.promise,
						construct: () => js`({value:null})`,
						resolve: ({ target }) => js`${target}.value=${nodes[4]}`,
						reject: () => js``
					};
				}, { id: `overlapping-opaque-${reverse}-${streaming}` });
				const target = client();
				const root = target.head(result.head);
				if (streaming) {
					pending.resolve(nodes[6]);
					later.resolve(leaf);
					job.ready.resolve(1);
					for await (const block of result.tail) target.block(block);
				}
				const revived_by_node = [];
				for (let i = 0; i < wrappers.length; i++) revived_by_node[index_by_node.get(wrappers[i].value)] = root.wrappers[i].value;
				for (let i = 1; i < revived_by_node.length; i++) expect(revived_by_node[i].child).toBe(revived_by_node[i - 1]);
				const revived_leaf = revived_by_node[0];
				expect(revived_leaf.self).toBe(revived_leaf);
				expect(revived_leaf.sparse[2]).toBe(revived_leaf);
				expect(revived_leaf.null_object.leaf).toBe(revived_leaf);
				expect(revived_leaf.view.buffer).toBe(revived_leaf.buffer);
				if (streaming) {
					expect(await root.pending).toBe(revived_by_node[6]);
					expect(await root.later).toBe(revived_leaf);
					expect(root.job.value).toBe(revived_by_node[4]);
				}
			}
		}
	});

	test('propagates a shorter opaque slot path after traversing a longer collection path', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}
		const pending = Promise.withResolvers();
		const child = { retained: true };
		const shared = { child };
		const holder = { veryLongPropertyName: { anotherLongPropertyName: shared } };
		const result = await unevalStream(
			{ collection: new Set([holder]), wrapped: new Wrapper(shared), pending: pending.promise },
			(value, js) => value instanceof Wrapper && js`({value:${value.value}})`,
			{ id: 'shorter-opaque-path' }
		);
		const target = client();
		const root = target.head(result.head);
		pending.resolve(child);
		const block = (await result.tail.next()).value;
		expect(block).toMatch(/\.s\[0\]\.child/);
		expect(block).not.toMatch(/veryLongPropertyName|anotherLongPropertyName/);
		target.block(block);
		expect(await root.pending).toBe(root.wrapped.value.child);
		expect(root.wrapped.value).toBe(Array.from(root.collection)[0].veryLongPropertyName.anotherLongPropertyName);
	});

	test('retains overlapping opaque roots introduced by an outcome for same and later batches', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}
		for (const reverse of [false, true]) {
			const introduced = Promise.withResolvers();
			const same = Promise.withResolvers();
			const later = Promise.withResolvers();
			const leaf = { retained: true };
			const parent = { child: leaf };
			parent.self = parent;
			const wrappers = [new Wrapper(leaf), new Wrapper(parent)];
			if (reverse) wrappers.reverse();
			const result = await unevalStream(
				{ introduced: introduced.promise, same: same.promise, later: later.promise },
				(value, js) => value instanceof Wrapper && js`({value:${value.value}})`,
				{ id: `outcome-overlapping-opaque-${reverse}` }
			);
			const target = client();
			const root = target.head(result.head);
			introduced.resolve(wrappers);
			same.resolve(leaf);
			target.block((await result.tail.next()).value);
			const revived = await root.introduced;
			const revived_leaf = revived.find((wrapper) => wrapper.value.retained).value;
			const revived_parent = revived.find((wrapper) => wrapper.value.child).value;
			expect(revived_parent.child).toBe(revived_leaf);
			expect(revived_parent.self).toBe(revived_parent);
			expect(await root.same).toBe(revived_leaf);
			later.resolve(leaf);
			target.block((await result.tail.next()).value);
			expect(await root.later).toBe(revived_leaf);
		}
	});

	test('plans legacy custom emission synchronously and invokes replacers once', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const pending = Promise.withResolvers();
		const child = { count: 1, values: [1] };
		let calls = 0;
		let yielded = false;
		queueMicrotask(() => { yielded = true; });
		const result_promise = unevalStream(
			{ child, wrapped: new Wrapper(child), pending: pending.promise },
			(value, js) => {
				if (!(value instanceof Wrapper)) return;
				calls++;
				expect(!yielded).toBeTruthy();
				return js`({value:${value.value}})`;
			},
			{ id: 'custom-plan' }
		);
		expect(calls).toBe(1);
		const result = await result_promise;
		const target = client();
		const root = target.head(result.head);
		expect(root.wrapped.value).toBe(root.child);
		expect(root.child.count).toBe(1);
		expect(root.child.values[0]).toBe(1);
		expect(calls).toBe(1);
		await result.tail.return();
	});

	test('composes a custom object dependency exactly once', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		let calls = 0;
		const { root } = await drain(await unevalStream(new Wrapper({ x: 1 }), (value, js) => {
			if (!(value instanceof Wrapper)) return;
			calls++;
			return js`({value:${value.value}})`;
		}));
		expect(calls).toBe(1);
		expect({ ...root.value }).toEqual({ x: 1 });
	});

	test('emits object children reachable only through custom source', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const { root } = await drain(await unevalStream(
			new Wrapper({ x: 1 }),
			(value, js) => value instanceof Wrapper && js`({value:${value.value}})`
		));
		expect({ ...root.value }).toEqual({ x: 1 });
	});

	test('preserves identity when one custom child source is repeated', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const { root } = await drain(await unevalStream(new Wrapper({}), (value, js) => {
			if (!(value instanceof Wrapper)) return;
			const child = js`${value.value}`;
			return js`[${child},${child}]`;
		}));
		expect(root[0]).toBe(root[1]);
	});

	test('preserves composed repeated custom holes in synchronous and streamed regions', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const synchronous = new Wrapper({ region: 'head' });
		const streamed = new Wrapper({ region: 'tail' });
		const pending = Promise.withResolvers();
		const calls = new Map();
		const result = await unevalStream({ synchronous, streamed: pending.promise }, (value, js) => {
			if (!(value instanceof Wrapper)) return;
			calls.set(value, (calls.get(value) ?? 0) + 1);
			const partial = js`[${value.value}`;
			const repeated = js`${value.value}`;
			return js`${partial},${repeated}]`;
		}, { id: 'composed-repeated-holes' });
		const target = client();
		const root = target.head(result.head);
		expect(root.synchronous[0]).toBe(root.synchronous[1]);
		expect(root.synchronous[0].region).toBe('head');
		expect(calls.get(synchronous)).toBe(1);
		expect(calls.has(streamed)).toBe(false);

		pending.resolve(streamed);
		target.block((await result.tail.next()).value);
		const revived = await root.streamed;
		expect(revived[0]).toBe(revived[1]);
		expect(revived[0].region).toBe('tail');
		expect(calls.get(streamed)).toBe(1);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('serializes primitive holes in custom source', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const { root } = await drain(await unevalStream(new Wrapper(undefined), (value, js) => {
			if (!(value instanceof Wrapper)) return;
			return js`[${value.value}]`;
		}));
		expect(root[0]).toBe(undefined);
	});

	test('preserves instruction-shaped objects as synchronous replacer data', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		for (const value of [
			{ type: 'reference', value: 1 },
			{ type: 'capture', value: 2 },
			{ type: 'outcome', value: 3 }
		]) {
			const { root } = await drain(await unevalStream(
				new Wrapper(value),
				(item, js) => item instanceof Wrapper && js`({value:${item.value}})`
			));
			expect(root.value.type).toBe(value.type);
			expect(root.value.value).toBe(value.value);
		}
		const inherited = { value: 4 };
		Object.defineProperty(Object.prototype, 'type', { value: 'outcome', configurable: true });
		try {
			const { root } = await drain(await unevalStream(
				new Wrapper(inherited),
				(item, js) => item instanceof Wrapper && js`({value:${item.value}})`
			));
			expect(root.value.value).toBe(4);
			expect(Object.hasOwn(root.value, 'type')).toBe(false);
		} finally {
			delete Object.prototype.type;
		}
	});

	test('serializes instruction-shaped descriptor holes as ordinary data', async () => {
		for (const value of [
			{ type: 'reference', value: 1 },
			{ type: 'capture', value: 2 },
			{ type: 'outcome', value: 3 }
		]) {
			const root = {};
			const result = await unevalStream(root, (candidate, js) => candidate === root && ({
				type: 'async-value',
				source: Promise.resolve(),
				construct: () => js`${value}`,
				resolve: () => js``,
				reject: () => js``
			}));
			const { root: revived } = await drain(result);
			expect(revived.type).toBe(value.type);
			expect(revived.value).toBe(value.value);
		}
	});

	test('rejects Symbols in descriptor construct capture and operation phases', async () => {
		for (const [phase, construct] of [
			['construct', (_capture, js) => js`${Symbol('construct')}`],
			['capture', (capture, js) => capture(js`${Symbol('capture')}`)]
		]) {
			const error = await rejects(unevalStream({}, (_value, js) => ({
				type: 'async-value', source: new Promise(() => {}),
				construct: (capture) => construct(capture, js),
				resolve: () => js``, reject: () => js``
			})), /received a Symbol.*Symbol values cannot be serialized as data/);
			expect(error).toBeInstanceOf(TypeError);
			expect(error.message.includes(`${phase}(), template hole 1`)).toBeTruthy();
		}

		const pending = Promise.withResolvers();
		const reports = [];
		const result = await unevalStream({}, (_value, js) => ({
			type: 'async-value', source: pending.promise, construct: () => js`({})`,
			resolve: () => js`${Symbol('operation')}`,
			reject: () => js`${Symbol('fallback')}`
		}), { id: 'symbol-operation', onerror: (error) => reports.push(error) });
		client().head(result.head);
		pending.resolve(1);
		await rejects(result.tail.next(), /fallback reject\(\), template hole 1: received a Symbol/);
		expect(reports.length).toBe(1);
		expect(reports[0].message).toMatch(/resolve\(\), template hole 1: received a Symbol/);
	});

	test('does not retain ownership of reported Symbol outcomes', async () => {
		for (const mode of ['writable', 'frozen', 'hostile message']) {
			const first = Promise.withResolvers();
			const scalar = Promise.withResolvers();
			const reused = Promise.withResolvers();
			const symbol = Symbol(mode);
			const reports = [];
			let message_reads = 0;
			const result = await unevalStream({ first: first.promise, scalar: scalar.promise, reused: reused.promise }, undefined, {
				id: `expired-native-symbol-${mode}`,
				onerror: (error) => reports.push(error)
			});
			const target = client();
			target.head(result.head);

			first.resolve(symbol);
			target.block((await result.tail.next()).value);
			expect(reports.length).toBe(1);
			const original = reports[0];
			expect(original.name).toBe('DevalueError');
			expect(original.message).toBe('Cannot stringify a Symbol primitive');
			const fields = { path: original.path, value: original.value, root: original.root };
			if (mode === 'frozen') Object.freeze(original);
			if (mode === 'hostile message') {
				Object.defineProperty(original, 'message', {
					configurable: true,
					get() { message_reads++; throw new Error('stale message inspected'); }
				});
			}

			// Successful primitive capture must not be what retires ownership.
			scalar.resolve(1);
			target.block((await result.tail.next()).value);
			const throwing = {};
			Object.defineProperty(throwing, 'prop', { enumerable: true, get() { throw original; } });
			reused.resolve(throwing);
			target.block((await result.tail.next()).value);

			expect(reports.length).toBe(2);
			expect(reports[1]).toBe(original);
			expect(original.path).toBe(fields.path);
			expect(original.value).toBe(fields.value);
			expect(original.root).toBe(fields.root);
			expect(message_reads).toBe(0);
		}
	});

	test('accepts exactly the synchronous replacer fallback set', async () => {
		for (const fallback of [undefined, null, false]) {
			const { root } = await drain(await unevalStream({ value: 1 }, () => fallback));
			expect(root.value).toBe(1);
		}
		for (const invalid of ['', 'x', 0, 1, true, Promise.resolve(), () => {}, {}, []]) {
			const error = await rejects(unevalStream({}, () => invalid), /Invalid unevalStream replacer result: received/);
			expect(error).toBeInstanceOf(TypeError);
			expect(error.message).toMatch(/js tagged template.*async-value.*async-sequence.*undefined, null, or false/);
			expect(error.message).toMatch(/must be synchronous; Promise results are not supported/);
			if (invalid === 0) expect(error.message).toMatch(/received a number \(0\)/);
		}
	});

	test('explains raw values returned from construction and passed to capture', async () => {
		for (const invalid of [undefined, null, false, 0, 'source', {}, () => {}, Promise.resolve()]) {
			for (const phase of ['capture', 'construct']) {
				const error = await rejects(unevalStream({}, (_value, js) => ({
					type: 'async-value', source: new Promise(() => {}),
					construct: (capture) => phase === 'capture' ? capture(invalid) : invalid,
					resolve: () => js``, reject: () => js``
				})), /js tagged template/);
				expect(error).toBeInstanceOf(TypeError);
				expect(error.message.includes(`${phase}() ${phase === 'capture' ? 'received' : 'returned'}`)).toBeTruthy();
			}
		}
	});

	test('serializes nested instruction-shaped operation holes as ordinary data', async () => {
		const pending = Promise.withResolvers();
		const reports = [];
		const job = {};
		const result = await unevalStream(job, (value, js) => value === job && ({
			type: 'async-value', source: pending.promise, construct: () => js`({})`,
			resolve: ({ target }) => js`${target}.value=${js`${{ type: 'reference' }}`}`,
			reject: ({ target }, reason) => js`${target}.error=${reason}`
		}), { onerror: (error, value) => reports.push([error, value]) });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(7);
		target.block((await result.tail.next()).value);
		expect(reports.length).toBe(0);
		expect(root.value.type).toBe('reference');
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('names each invalid operation callback and its fallback without changing error boundaries', async () => {
		for (const phase of ['resolve', 'reject', 'next', 'complete', 'error']) {
			const pending = Promise.withResolvers();
			const reports = [];
			const sequence = ['next', 'complete', 'error'].includes(phase);
			const job = {};
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: sequence ? 'async-sequence' : 'async-value',
				source: sequence ? {
					[Symbol.asyncIterator]() { return this; },
					next() { return pending.promise; },
					return() { return { done: true }; }
				} : pending.promise,
				construct: () => js`({})`,
				resolve: () => 0, reject: () => null,
				next: () => 0, complete: () => 0, error: () => null
			}), { onerror: (error) => reports.push(error) });
			client().head(result.head);
			const terminal_error = phase === 'reject' || phase === 'error';
			if (terminal_error) pending.reject('reason');
			else pending.resolve(sequence ? { done: phase === 'complete', value: 1 } : 1);
			const error = await rejects(result.tail.next(), /must synchronously return a js tagged template.*empty operation/);
			expect(error).toBeInstanceOf(TypeError);
			if (terminal_error) {
				expect(error.message.includes(`${phase}() returned null`)).toBeTruthy();
				expect(reports.length).toBe(0);
			} else {
				expect(error.message.includes(`fallback ${sequence ? 'error' : 'reject'}() returned null`)).toBeTruthy();
				expect(reports.length).toBe(1);
				expect(reports[0].message.includes(`${phase}() returned a number (0)`)).toBeTruthy();
			}
		}
	});

	test('preserves synchronous custom replacement expression boundaries', async () => {
		class Wrapper { constructor(kind) { this.kind = kind; } }
		const cases = [
			['comma', (js) => js`1,2`, 2],
			['conditional', (js) => js`true?3:4`, 3],
			['object', (js) => js`{value:5}`, { value: 5 }],
			['nested partial', (js) => js`[${js`1,2`}]`, [1, 2]],
			['partial nested', (js) => js`${js`Math.max(`}${js`6,7`})`, 7],
			['escaped data', (js) => js`${'</script>'}`, '</script>']
		];
		for (const [kind, source, expected] of cases) {
			const { root } = await drain(await unevalStream(new Wrapper(kind), (value, js) =>
				value instanceof Wrapper && source(js)
			));
			if (typeof expected === 'object') expect(JSON.parse(JSON.stringify(root))).toEqual(expected);
			else expect(root).toBe(expected);
		}
		const { root } = await drain(await unevalStream(
			{
				array: [new Wrapper('array boundary')],
				object: { value: new Wrapper('object boundary') },
				argument: new Wrapper('argument boundary')
			},
			(value, js) => value instanceof Wrapper && js`1,2`
		));
		expect(Array.from(root.array)).toEqual([2]);
		expect(root.object.value).toBe(2);
		expect(root.argument).toBe(2);

		class Container { constructor(child) { this.child = child; } }
		const embedded = await drain(await unevalStream(new Container(new Wrapper('object child')), (value, js) => {
			if (value instanceof Container) return js`(x=>x)(${value.child})`;
			if (value instanceof Wrapper) return js`{value:8}`;
		}));
		expect({ ...embedded.root }).toEqual({ value: 8 });
	});

	test('preserves replacement metacharacters in descriptor capture expressions', async () => {
		for (const text of ['$&', '$`', "$'", '$$']) {
			const result = await unevalStream({}, (_value, js) => ({
				type: 'async-value',
				source: Promise.resolve(1),
				construct: (capture) => capture(js`${text}`),
				resolve: () => js``,
				reject: () => js``
			}));
			const { root } = await drain(result);
			expect(root).toBe(text);
		}
	});

	test('rejects Symbol children passed to a custom replacer', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		await rejects(
			unevalStream(new Wrapper(Symbol('child')), (value, js) => value instanceof Wrapper && js`[${value.value}]`),
			/Cannot stringify a Symbol primitive/
		);
	});

	test('ignores unused custom object children without retaining stream state', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		class Job {}
		const job = new Job();
		let then_reads = 0;
		let cancels = 0;
		const source = { get then() { then_reads++; return () => {}; } };
		const replacer = (value, js) => {
			if (value instanceof Wrapper) {
				for (let i = 0; i < 100; i++) js`${i % 2 ? job : Promise.resolve(i)}`;
				return js`({value:1})`;
			}
			if (value === job) return {
				type: 'async-value', source, construct: () => js`({})`,
				resolve: () => js``, reject: () => js``, cancel() { cancels++; }
			};
		};
		const result = await unevalStream(new Wrapper(job), replacer, { id: 'unused-child' });
		expect(result.head).not.toMatch(/globalThis\.__d/);
		expect(client().head(result.head).value).toBe(1);
		expect(result.head).not.toMatch(/pending|slots|__d/);
		expect(then_reads).toBe(0);
		expect(cancels).toBe(0);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('reconstructs mixed custom and plain object cycles', async () => {
		class Wrapper { constructor() { this.value = undefined; } }
		const wrapper = new Wrapper();
		const object = { wrapper };
		wrapper.value = object;
		const { root } = await drain(await unevalStream(
			wrapper,
			(value, js) => value instanceof Wrapper && js`({value:${value.value}})`
		));
		expect(root.value.wrapper).toBe(root);
	});

	test('constructs custom child views after their buffers and before their target', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const buffer = new ArrayBuffer(8);
		const view = new Uint8Array(buffer, 2, 3);
		const { root } = await drain(await unevalStream(new Wrapper(view), (value, js) => {
			if (!(value instanceof Wrapper)) return;
			const child = js`${value.value}`;
			return js`({view:${child},buffer:${child}.buffer})`;
		}));
		expect(Object.prototype.toString.call(root.view)).toBe('[object Uint8Array]');
		expect(root.view.buffer).toBe(root.buffer);
		expect(root.view.byteOffset).toBe(2);
		expect(root.view.length).toBe(3);
	});

	test('does not replace protocol alias text that resembles a custom token', async () => {
		class Wrapper { constructor(value) { this.value = value; } }
		const text = '"0"';
		const { root } = await drain(await unevalStream(new Wrapper({}), (value, js) => {
			if (!(value instanceof Wrapper)) return;
			return js`({text:${text},value:${value.value}})`;
		}, { id: 'collision' }));
		expect(root.text).toBe(text);
	});

	test('round-trips numeric strings keys ids and former token literals in every phase', async () => {
		class Literal {}
		const synchronous = await unevalStream(
			{ '0': '0', '1': '1', '12': '12', '001': '001', literal: new Literal() },
			(value, js) => value instanceof Literal && js`"0"`
		);
		const sync_root = client().head(synchronous.head);
		expect(JSON.parse(JSON.stringify(sync_root))).toEqual({ '0': '0', '1': '1', '12': '12', '001': '001', literal: '0' });

		const folded = await unevalStream(Promise.resolve('0'), undefined, { id: '12' });
		expect(await client().head(folded.head)).toBe('0');

		const pending = Promise.withResolvers();
		const object = Promise.withResolvers();
		const tail = await unevalStream({ '00': pending.promise, object: object.promise }, undefined, { id: '0' });
		const target = client();
		const root = target.head(tail.head);
		pending.resolve('0');
		object.resolve({ '1': '12', value: '001' });
		target.block((await tail.tail.next()).value);
		expect(await root['00']).toBe('0');
		expect(JSON.parse(JSON.stringify(await root.object))).toEqual({ '1': '12', value: '001' });
	});

	test('discards nested async sources when custom-cycle validation fails', async () => {
		class Wrapper { constructor() { this.value = this; } }
		class Job { constructor() { this.started = false; } }
		const pending = Promise.withResolvers();
		const job = new Job();
		const result = await unevalStream(pending.promise, (value, js) => {
			if (value instanceof Wrapper) return js`({value:${value.value}})`;
			if (value instanceof Job) return {
				type: 'async-value',
				source: value,
				construct: () => js`({})`,
				then: () => { value.started = true; },
				resolve: () => js``,
				reject: () => js``
			};
		}, { id: 'failed-cycle-source' });
		const target = client();
		const root = target.head(result.head);
		const rejected = rejects(root, /failed to serialize asynchronous value/);
		pending.resolve({ job, invalid: new Wrapper() });
		target.block((await result.tail.next()).value);
		await rejected;
		expect(job.started).toBe(false);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('adapts a nonthenable custom async value', async () => {
		class Job { constructor(completion) { this.completion = completion; } }
		const pending = Promise.withResolvers();
		const replacer = (value, js) => value instanceof Job && ({
			type: 'async-value', source: value.completion,
			construct: () => js`({value:void 0,error:void 0,resolve(v){this.value=v},reject(e){this.error=e}})`,
			resolve: ({ target }, payload) => js`${target}.resolve(${payload})`,
			reject: ({ target }, reason) => js`${target}.reject(${reason})`
		});
		const result = await unevalStream(new Job(pending.promise), replacer, { id: 'job' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve({ ok: true });
		target.block((await result.tail.next()).value);
		expect({ ...root.value }).toEqual({ ok: true });
	});

	test('normalizes a misbehaving custom thenable', async () => {
		const source = { then(resolve, reject) { resolve(1); reject(2); throw new Error('late'); } };
		const replacer = (_value, js) => ({
			type: 'async-value', source, construct: () => js`({values:[],set(v){this.values.push(v)}})`,
			resolve: ({ target }, value) => js`${target}.set(${value})`, reject: ({ target }, value) => js`${target}.set(${value})`
		});
		const { root } = await drain(await unevalStream({}, replacer, { id: 'thenable' }));
		expect(Array.from(root.values)).toEqual([1]);
	});

	test('keeps distinct custom values distinct when they share a source', async () => {
		const pending = Promise.withResolvers();
		class Job {}
		const replacer = (value, js) => value instanceof Job && ({
			type: 'async-value', source: pending.promise, construct: () => js`({value:void 0})`,
			resolve: ({ target }, source) => js`${target}.value=${source}`,
			reject: ({ target }, source) => js`${target}.value=${source}`
		});
		const result = await unevalStream([new Job(), new Job()], replacer, { id: 'distinct' });
		const target = client();
		const root = target.head(result.head);
		expect(root[0] !== root[1]).toBeTruthy();
		pending.resolve(1);
		for await (const block of result.tail) target.block(block);
		expect(root[0].value).toBe(1);
		expect(root[1].value).toBe(1);
	});

	function sequence_replacer(source) {
		return (value, js) => value === source && ({
			type: 'async-sequence', source,
			construct: () => js`({events:[],next(v){this.events.push(["next",v])},complete(v){this.events.push(["complete",v])},error(v){this.events.push(["error",v])}})`,
			next: ({ target }, value) => js`${target}.next(${value})`,
			complete: ({ target }, value) => js`${target}.complete(${value})`,
			error: ({ target }, value) => js`${target}.error(${value})`
		});
	}

	test('feeds async iterable yields and return value into the client target', async () => {
		const source = { async *[Symbol.asyncIterator]() { yield 1; yield 2; return 3; } };
		const { root } = await drain(await unevalStream(source, sequence_replacer(source), { id: 'sequence' }));
		expect(JSON.parse(JSON.stringify(root.events))).toEqual([['next', 1], ['next', 2], ['complete', 3]]);
	});

	test('uses null-prototype next callables for initial and resumed sequence pulls', async () => {
		for (const native of [false, true]) {
			let pulls = 0;
			const receivers = [];
			const argument_counts = [];
			const iterator = {};
			iterator.next = null_prototype_callable(function () {
				pulls++;
				receivers.push(this);
				argument_counts.push(arguments.length);
				return pulls < 3 ? { done: false, value: pulls } : { done: true, value: 3 };
			});
			const source = { [Symbol.asyncIterator]() { return iterator; } };
			const result = await unevalStream(source, native ? undefined : sequence_replacer(source), { id: `null-next-${native}` });
			const { root } = await drain(result);
			if (native) {
				expect({ ...await root.next() }).toEqual({ done: false, value: 1 });
				expect({ ...await root.next() }).toEqual({ done: false, value: 2 });
				expect({ ...await root.next() }).toEqual({ done: true, value: 3 });
			} else {
				expect(JSON.parse(JSON.stringify(root.events))).toEqual([['next', 1], ['next', 2], ['complete', 3]]);
			}
			expect(pulls).toBe(3);
			expect(receivers).toEqual([iterator, iterator, iterator]);
			expect(argument_counts).toEqual([0, 0, 0]);
		}
	});

	test('natively reconstructs async iterables as buffered iterators', async () => {
		const shared = { value: 1 };
		const source = { async *[Symbol.asyncIterator]() { yield shared; yield 2; return shared; } };
		const result = await unevalStream({ shared, source }, undefined, { id: 'native-sequence' });
		const target = client();
		const root = target.head(result.head);
		expect(root.source[Symbol.asyncIterator]()).toBe(root.source);
		expect(Reflect.ownKeys(root.source).filter((key) => typeof key === 'string').sort()).toEqual(['next', 'return', 'throw']);
		expect(root.source._n).toBe(undefined);
		expect(root.source._c).toBe(undefined);
		expect(root.source._e).toBe(undefined);
		const first = root.source.next();
		const second = root.source.next();
		const third = root.source.next();
		for await (const block of result.tail) target.block(block);
		const a = await first;
		const b = await second;
		const c = await third;
		expect(a.done).toBe(false);
		expect(a.value).toBe(root.shared);
		expect(b.done).toBe(false);
		expect(b.value).toBe(2);
		expect(c.done).toBe(true);
		expect(c.value).toBe(root.shared);
	});

	test('reads the native async iterator getter once after descriptor commit', async () => {
		let reads = 0;
		let replaced = false;
		const source = {
			get [Symbol.asyncIterator]() {
				reads++;
				expect(replaced).toBeTruthy();
				return async function* () { yield 1; };
			}
		};
		const { root } = await drain(await unevalStream(source, (value) => {
			if (value === source) replaced = true;
		}));
		expect(reads).toBe(1);
		expect({ ...await root.next() }).toEqual({ done: false, value: 1 });
	});

	test('buffers native async iterable events before client next', async () => {
		const source = { async *[Symbol.asyncIterator]() { yield 1; return 2; } };
		const { root } = await drain(await unevalStream(source, undefined, { id: 'native-buffer' }));
		expect({ ...await root.next() }).toEqual({ done: false, value: 1 });
		expect({ ...await root.next() }).toEqual({ done: true, value: 2 });
		expect({ ...await root.next() }).toEqual({ done: true, value: undefined });
	});

	test('delivers buffered native yields before source errors', async () => {
		const reason = 'source failure';
		const source = { async *[Symbol.asyncIterator]() { yield 1; throw reason; } };
		const { root } = await drain(await unevalStream(source, undefined, { id: 'native-buffer-error' }));
		expect({ ...await root.next() }).toEqual({ done: false, value: 1 });
		await rejects(root.next(), reason);
		expect({ ...await root.next() }).toEqual({ done: true, value: undefined });
	});

	test('settles multiple pending native next calls on terminal events', async () => {
		for (const terminal of ['complete', 'error']) {
			const ready = Promise.withResolvers();
			const reason = 'terminal';
			const source = {
				async *[Symbol.asyncIterator]() {
					await ready.promise;
					if (terminal === 'error') throw reason;
					return 7;
				}
			};
			const result = await unevalStream(source, undefined, { id: `native-pending-${terminal}` });
			const target = client();
			const root = target.head(result.head);
			const pending = [root.next(), root.next(), root.next()];
			const rejected = terminal === 'error' ? rejects(pending[0], reason) : undefined;
			ready.resolve();
			for await (const block of result.tail) target.block(block);
			if (terminal === 'complete') {
				const settled = await Promise.all(pending);
				expect({ ...settled[0] }).toEqual({ done: true, value: 7 });
				expect({ ...settled[1] }).toEqual({ done: true, value: undefined });
				expect({ ...settled[2] }).toEqual({ done: true, value: undefined });
				expect(settled[0] !== settled[1] && settled[1] !== settled[2]).toBeTruthy();
			} else {
				await rejected;
				expect({ ...await pending[1] }).toEqual({ done: true, value: undefined });
				expect({ ...await pending[2] }).toEqual({ done: true, value: undefined });
			}
		}
	});

	test('reports native async iterable failures and unserializable yields', async () => {
		for (const source of [
			{ async *[Symbol.asyncIterator]() { throw new Error('source failure'); } },
			{ async *[Symbol.asyncIterator]() { yield () => {}; } }
		]) {
			const result = await unevalStream(source);
			const target = client();
			const root = target.head(result.head);
			const failed = rejects(root.next());
			for await (const block of result.tail) target.block(block);
			await failed;
		}
	});

	test('server cancellation closes a native async generator', async () => {
		let finalized = false;
		const source = { async *[Symbol.asyncIterator]() { try { yield 1; yield 2; } finally { finalized = true; } } };
		const result = await unevalStream(source, undefined, { id: 'native-cancel' });
		await result.tail.return();
		expect(finalized).toBeTruthy();
	});

	test('native client return and throw are local and ignore later updates', async () => {
		for (const method of ['return', 'throw']) {
			const ready = Promise.withResolvers();
			let returned = 0;
			const source = {
				[Symbol.asyncIterator]() { return this; },
				async next() { await ready.promise; return { done: false, value: 1 }; },
				return() { returned++; return { done: true }; }
			};
			const result = await unevalStream(source, undefined, { id: `native-local-${method}` });
			const target = client();
			const root = target.head(result.head);
			const pending = root.next();
			const reason = new Error('local');
			if (method === 'return') {
				expect({ ...await root.return(7) }).toEqual({ done: true, value: 7 });
				expect({ ...await pending }).toEqual({ done: true, value: undefined });
			} else {
				await rejects(root.throw(reason), reason);
				await rejects(pending, reason);
			}
			expect(returned).toBe(0);
			ready.resolve();
			const block = await result.tail.next();
			if (!block.done) target.block(block.value);
			await result.tail.return();
			expect(returned).toBe(1);
		}
	});

	test('native client close discards updates buffered before server termination', async () => {
		for (const method of ['return', 'throw']) {
			const source = { async *[Symbol.asyncIterator]() { yield 1; return 2; } };
			const { root } = await drain(await unevalStream(source, undefined, { id: `native-buffered-close-${method}` }));
			const reason = new Error(method);
			if (method === 'return') expect({ ...await root.return(7) }).toEqual({ done: true, value: 7 });
			else await rejects(root.throw(reason), reason);
			expect({ ...await root.next() }).toEqual({ done: true, value: undefined });
		}
	});

	test('replacer overrides native async iterable handling', async () => {
		const source = { async *[Symbol.asyncIterator]() { yield 1; } };
		const { root, blocks } = await drain(await unevalStream(source, (value, js) => value === source && js`({overridden:true})`));
		expect(root.overridden).toBe(true);
		expect(blocks).toEqual([]);
	});

	test('turns malformed async iterable protocols into adapter-appropriate client errors', async () => {
		const shared_sources = [
			{ get [Symbol.asyncIterator]() { throw new Error('getter'); } },
			{ [Symbol.asyncIterator]() { return null; } },
			{ [Symbol.asyncIterator]() { return {}; } },
			{ [Symbol.asyncIterator]() { return { next() { return null; } }; } }
		];
		for (const source of shared_sources) {
			// native adapter: the reconstructed client iterator reports the failure
			const native = await unevalStream(source);
			const native_target = client();
			const native_root = native_target.head(native.head);
			const native_failed = rejects(native_root.next());
			for await (const block of native.tail) native_target.block(block);
			await native_failed;
			// custom adapter: the error operation reports the same protocol failure
			const custom = await drain(await unevalStream(source, sequence_replacer(source)));
			expect(custom.root.events.length).toBe(1);
			expect(custom.root.events[0][0]).toBe('error');
		}
		// native adapter only: a non-callable protocol method
		for (const source of [{ [Symbol.asyncIterator]: 1 }]) {
			const result = await unevalStream(source);
			const target = client();
			const root = target.head(result.head);
			const failed = rejects(root.next());
			for await (const block of result.tail) target.block(block);
			await failed;
		}
		// custom adapter only: acquisition, result, and accessor failures
		const custom_sources = [
			{ [Symbol.asyncIterator]() { throw new Error('call'); } },
			{ [Symbol.asyncIterator]() { return { next() { throw new Error('next'); } }; } },
			{ [Symbol.asyncIterator]() { return { next() { return { get done() { throw new Error('done'); } }; } }; } },
			{ [Symbol.asyncIterator]() { return { next() { return { done: false, get value() { throw new Error('value'); } }; } }; } }
		];
		for (const source of custom_sources) {
			const { root } = await drain(await unevalStream(source, sequence_replacer(source)));
			expect(root.events.length).toBe(1);
			expect(root.events[0][0]).toBe('error');
		}
	});

	test('reads a throwing native async iterator getter once and reports it to the client', async () => {
		let reads = 0;
		let replaced = false;
		const source = {
			get [Symbol.asyncIterator]() {
				reads++;
				expect(replaced).toBeTruthy();
				throw new Error('getter');
			}
		};
		const result = await unevalStream(source, (value) => {
			if (value === source) replaced = true;
		});
		expect(reads).toBe(1);
		const target = client();
		const root = target.head(result.head);
		const failed = rejects(root.next());
		for await (const block of result.tail) target.block(block);
		await failed;
		expect(reads).toBe(1);
	});

	test('preserves sequence return-value identity', async () => {
		const shared = { value: 1 };
		const source = { async *[Symbol.asyncIterator]() { yield shared; return shared; } };
		const { root } = await drain(await unevalStream({ shared, source }, sequence_replacer(source), { id: 'sequence-return-identity' }));
		expect(root.source.events[0][1]).toBe(root.shared);
		expect(root.source.events[1][1]).toBe(root.shared);
	});

	test('keeps distinct sequence descriptors sharing an iterator source distinct', async () => {
		class Sequence {}
		const iterator = {
			count: 0,
			next() { return Promise.resolve(++this.count <= 2 ? { done: false, value: this.count } : { done: true, value: 'done' }); }
		};
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const replacer = (value, js) => value instanceof Sequence && ({
			type: 'async-sequence', source,
			construct: () => js`({events:[]})`,
			next: ({ target }, value) => js`${target}.events.push(${value})`,
			complete: ({ target }, value) => js`${target}.events.push(${value})`,
			error: ({ target }, value) => js`${target}.events.push(${value})`
		});
		const { root } = await drain(await unevalStream([new Sequence(), new Sequence()], replacer, { id: 'shared-iterator' }));
		expect(root[0] !== root[1]).toBeTruthy();
		expect(Array.from(root[0].events)).toEqual([1, 'done']);
		expect(Array.from(root[1].events)).toEqual([2, 'done']);
	});

	test('includes at most one sequence item in each batch', async () => {
		let pulls = 0;
		const source = { [Symbol.asyncIterator]() { return this; }, async next() { pulls++; return pulls < 3 ? { done: false, value: pulls } : { done: true }; } };
		const result = await unevalStream(source, sequence_replacer(source), { id: 'coalesce' });
		const target = client();
		const root = target.head(result.head);
		expect(pulls).toBe(2);
		expect(JSON.parse(JSON.stringify(root.events))).toEqual([['next', 1]]);
		for await (const block of result.tail) target.block(block);
		expect(JSON.parse(JSON.stringify(root.events))).toEqual([['next', 1], ['next', 2], ['complete', null]]);
	});

	test('backpressures an async sequence until flushed blocks are consumed', async () => {
		let pulls = 0;
		const gates = [];
		const pull_arrived = [];
		const source = {
			[Symbol.asyncIterator]() { return this; },
			next() {
				pulls++;
				const gate = Promise.withResolvers();
				const arrived = Promise.withResolvers();
				gates.push(gate);
				pull_arrived.push(arrived);
				arrived.resolve();
				return gate.promise;
			}
		};
		const result = await unevalStream(source, sequence_replacer(source), { id: 'pressure' });
		const target = client();
		target.head(result.head);
		expect(pulls).toBe(1);
		// a ready but unconsumed batch is not re-pulled (real flush window)
		gates[0].resolve({ done: false, value: 1 });
		await delay(5);
		expect(pulls).toBe(1);
		const first_block = (await result.tail.next()).value;
		target.block(first_block);
		// dequeuing the batch releases exactly one further pull, deterministically
		await pull_arrived[1].promise;
		expect(pulls).toBe(2);
		gates[1].resolve({ done: false, value: 2 });
		target.block((await result.tail.next()).value);
		await pull_arrived[2].promise;
		expect(pulls).toBe(3);
		gates[2].resolve({ done: true });
		target.block((await result.tail.next()).value);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('resumes sequence pulling after batches accumulate while the consumer is idle', async () => {
		const source = { async *[Symbol.asyncIterator]() { yield 1; yield 2; yield 3; } };
		// settles a few flush windows after the sequence's first item, while nobody is reading
		const late = new Promise((resolve) => setTimeout(() => resolve('late'), 5));
		const result = await unevalStream({ source, late }, undefined, { id: 'idle-consumer' });
		const target = client();
		const root = target.head(result.head);
		await delay(30);
		const seen = [];
		const drained = (async () => {
			for await (const value of root.source) seen.push(value);
		})();
		for await (const block of result.tail) target.block(block);
		await drained;
		expect(seen).toEqual([1, 2, 3]);
		expect(await root.late).toBe('late');
		expect(!Object.hasOwn(target.context.__d, 'idle-consumer')).toBeTruthy();
	});

	test('cancels an async sequence before tail iteration starts', async () => {
		let returned = 0;
		const pending = Promise.withResolvers();
		const source = { [Symbol.asyncIterator]() { return this; }, next() { return pending.promise; }, return() { returned++; return { done: true }; } };
		const result = await unevalStream(source, sequence_replacer(source), { id: 'cancel' });
		const returned_result = result.tail.return();
		pending.resolve({ done: true });
		await returned_result;
		expect(returned).toBe(1);
	});

	test('calls sequence return while next is outstanding', async () => {
		const pending = Promise.withResolvers();
		let pulling = false;
		let returned = 0;
		const source = {
			[Symbol.asyncIterator]() { return this; },
			next() {
				expect(!pulling).toBeTruthy();
				pulling = true;
				return pending.promise.finally(() => { pulling = false; });
			},
			return() {
				expect(pulling).toBeTruthy();
				returned++;
				pending.resolve({ done: false, value: 1 });
				return { done: true };
			}
		};
		const result = await unevalStream(source, sequence_replacer(source), { id: 'pending-next-return' });
		const next = result.tail.next();
		const returned_result = result.tail.return();
		expect(await next).toEqual({ done: true, value: undefined });
		expect(await returned_result).toEqual({ done: true, value: undefined });
		expect(returned).toBe(1);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('isolates concurrent stream sessions', async () => {
		const a = Promise.withResolvers();
		const b = Promise.withResolvers();
		const first = await unevalStream(a.promise, undefined, { id: 'a' });
		const second = await unevalStream(b.promise, undefined, { id: 'b' });
		const target = client();
		const ar = target.head(first.head);
		const br = target.head(second.head);
		a.resolve(1); b.resolve(2);
		target.block((await first.tail.next()).value);
		target.block((await second.tail.next()).value);
		expect(await ar).toBe(1);
		expect(await br).toBe(2);
	});

	test('accepts dangerous session ids as own properties', async () => {
		for (const id of ['__proto__', 'constructor']) {
			const pending = Promise.withResolvers();
			const result = await unevalStream(pending.promise, undefined, { id });
			const target = client();
			const root = target.head(result.head);
			expect(Object.hasOwn(target.context.__d, id)).toBeTruthy();
			expect(Object.getPrototypeOf(target.context.__d)).toBe(null);
			pending.resolve(id);
			target.block((await result.tail.next()).value);
			expect(await root).toBe(id);
		}
	});

	test('cleans the client session in the final evaluated block', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'cleanup' });
		const target = client();
		target.head(result.head);
		pending.resolve(1);
		target.block((await result.tail.next()).value);
		expect(!Object.hasOwn(target.context.__d, 'cleanup')).toBeTruthy();
		expect(Object.getPrototypeOf(target.context.__d)).toBe(null);
	});

	test('serves concurrent tail next calls in order', async () => {
		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		const result = await unevalStream([first.promise, second.promise], undefined, { id: 'concurrent' });
		const target = client();
		const root = target.head(result.head);
		const reads = [result.tail.next(), result.tail.next(), result.tail.next()];
		first.resolve(1);
		// the first read receives its own batch before the second settlement
		const a = await reads[0];
		second.resolve(2);
		const [b, c] = await Promise.all([reads[1], reads[2]]);
		expect(a.done).toBe(false);
		expect(b.done).toBe(false);
		expect(c).toEqual({ done: true, value: undefined });
		target.block(a.value);
		target.block(b.value);
		expect(await Promise.all(root)).toEqual([1, 2]);
	});

	test('rejects pre-aborted signals before invoking a replacer', async () => {
		const controller = new AbortController();
		const reason = new Error('aborted');
		controller.abort(reason);
		let calls = 0;
		await rejects(unevalStream({}, () => { calls++; }, { signal: controller.signal }), reason);
		expect(calls).toBe(0);
	});

	test('rejects aborts raised during descriptor construction', async () => {
		const controller = new AbortController();
		const reason = new Error('aborted during construct');
		let cancels = 0;
		await rejects(unevalStream({}, (_value, js) => ({
			type: 'async-value',
			source: new Promise(() => {}),
			construct() {
				controller.abort(reason);
				return js`0`;
			},
			resolve: () => js``,
			reject: () => js``,
			cancel() { cancels++; }
		}), { signal: controller.signal }), reason);
		expect(cancels).toBe(0);
	});

	test('tail return cancels an outstanding next', async () => {
		let cancels = 0;
		const result = await unevalStream({}, (_value, js) => ({
			type: 'async-value', source: new Promise(() => {}), construct: () => js`0`,
			resolve: () => js``, reject: () => js``, cancel() { cancels++; }
		}));
		const next = result.tail.next();
		expect(await result.tail.return()).toEqual({ done: true, value: undefined });
		expect(await next).toEqual({ done: true, value: undefined });
		expect(cancels).toBe(1);
	});

	test('tail return can close a permanently pending sequence pull', async () => {
		const pending = Promise.withResolvers();
		let pulling = false;
		let returned = 0;
		const source = {
			[Symbol.asyncIterator]() { return this; },
			next() {
				pulling = true;
				return pending.promise.finally(() => { pulling = false; });
			},
			return() {
				expect(pulling).toBeTruthy();
				returned++;
				pending.resolve({ done: true });
				return { done: true };
			}
		};
		const result = await unevalStream(source, sequence_replacer(source));
		const next = result.tail.next();
		const returned_result = result.tail.return();
		expect(await returned_result).toEqual({ done: true, value: undefined });
		expect(await next).toEqual({ done: true, value: undefined });
		expect(returned).toBe(1);
	});

	test('preserves deep identity across a pending Promise batch', async () => {
		const pending = Promise.withResolvers();
		const deep = { a: { b: { c: {} } } };
		const result = await unevalStream({ deep, pending: pending.promise }, undefined, { id: 'sizes' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve([deep.a.b.c, deep.a.b.c, deep.a.b.c]);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		const pending_value = await root.pending;
		expect(pending_value).toEqual([root.deep.a.b.c, root.deep.a.b.c, root.deep.a.b.c]);
		expect(pending_value[0]).toBe(pending_value[1]);
	});

	test('resolves a pending primitive Promise through an executable tail block', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'size' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(1);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		expect(await root).toBe(1);
	});

	test('delivers native sequence outcomes as one executable batch per pull', async () => {
		const ready = Promise.withResolvers();
		const source = { async *[Symbol.asyncIterator]() { await ready.promise; yield 1; return 2; } };
		const result = await unevalStream(source, undefined, { id: 'native-size' });
		const target = client();
		const iterator = target.head(result.head);
		ready.resolve();
		// Each iterator pull gets its own batch, including the terminal result.
		const item = (await result.tail.next()).value;
		target.block(item);
		expect(await iterator.next()).toEqual({ done: false, value: 1 });
		const complete = (await result.tail.next()).value;
		target.block(complete);
		expect(await iterator.next()).toEqual({ done: true, value: 2 });
		expect(await iterator.next()).toEqual({ done: true, value: undefined });

		const fail = Promise.withResolvers();
		const failed = await unevalStream({ async *[Symbol.asyncIterator]() { await fail.promise; throw { code: 'boom' }; } }, undefined, { id: 'native-size-error' });
		const failing = target.head(failed.head);
		fail.resolve();
		const errored = (await failed.tail.next()).value;
		target.block(errored);
		await expect(failing.next()).rejects.toEqual({ code: 'boom' });

		const opaque = Promise.withResolvers();
		const unserializable = await unevalStream({ async *[Symbol.asyncIterator]() { await opaque.promise; throw new Error('secret'); } }, undefined, { id: 'native-size-opaque' });
		const leaking = target.head(unserializable.head);
		opaque.resolve();
		const guarded = (await unserializable.tail.next()).value;
		target.block(guarded);
		// an Error reason cannot be serialized as data, so the tail block delivers
		// the generic failure instead of leaking error internals
		await expect(leaking.next()).rejects.toMatchObject({ message: 'devalue: failed to serialize asynchronous value' });
	});

	test('validates replacer results and descriptor shapes synchronously', async () => {
		for (const value of [true, 1, {}, { nope: true }]) {
			await rejects(unevalStream({}, () => value), /Invalid unevalStream replacer result/);
		}
		for (const [type, missing] of [['async-value', 'resolve'], ['async-sequence', 'next']]) {
			const descriptor = type === 'async-value'
				? { type, source: {}, construct: () => ({}), resolve() {}, reject() {} }
				: { type, source: {}, construct: () => ({}), next() {}, complete() {}, error() {} };
			delete descriptor[missing];
			const error = await rejects(unevalStream({}, () => descriptor), new RegExp(`Invalid ${type} ${missing}: received undefined`));
			expect(error.message.includes(`must provide a ${missing}() function`)).toBeTruthy();
		}
	});

	test('explains descriptor source and cleanup field requirements', async () => {
		for (const type of ['async-value', 'async-sequence']) {
			for (const field of ['source', 'cancel']) {
				const error = await rejects(unevalStream({}, (_value, js) => ({
					type, source: {}, construct: () => js`({})`,
					resolve() {}, reject() {}, next() {}, complete() {}, error() {},
					[field]: null
				})), new RegExp(`Invalid ${type} ${field}: received null`));
				expect(error).toBeInstanceOf(TypeError);
				expect(error.message).toMatch(field === 'cancel'
					? /Omit cancel or provide a cleanup function/
					: type === 'async-value' ? /Promise-like.*callable then method/ : /async iterable.*Symbol.asyncIterator/);
			}
		}
	});

	test('rejects multiple descriptor capture calls and invokes construct once', async () => {
		let constructs = 0;
		const replacer = (_value, js) => ({
			type: 'async-value', source: new Promise(() => {}),
			construct(capture) { constructs++; capture(js`1`); capture(js`2`); return js`0`; },
			resolve: () => js``, reject: () => js``
		});
		await rejects(unevalStream({}, replacer), /capture may only be called once/);
		expect(constructs).toBe(1);
	});

	test('reads a custom then exactly once and binds its receiver', async () => {
		let reads = 0;
		const source = {
			get then() {
				reads++;
				return function (resolve) { expect(this).toBe(source); resolve(7); };
			}
		};
		const replacer = (_value, js) => ({
			type: 'async-value', source, construct: () => js`({value:0})`,
			resolve: ({ target }, value) => js`${target}.value=${value}`,
			reject: ({ target }, value) => js`${target}.value=${value}`
		});
		const { root } = await drain(await unevalStream({}, replacer, { id: 'then-read' }));
		expect(root.value).toBe(7);
		expect(reads).toBe(1);
	});

	test('turns custom then lookup and call failures into client rejection events', async () => {
		for (const source of [
			{ get then() { throw new Error('lookup'); } },
			{ then: 1 },
			{ then() { throw new Error('call'); } }
		]) {
			const job = {};
			const replacer = (value, js) => value === job && ({
				type: 'async-value', source, construct: () => js`({error:void 0})`,
				resolve: ({ target }, value) => js`${target}.value=${value}`,
				reject: ({ target }, value) => js`${target}.error=${value}`
			});
			const { root } = await drain(await unevalStream(job, replacer));
			expect(root.error && typeof root.error.message === 'string').toBeTruthy();
		}
	});

	test('adopts nested thenables for custom async values', async () => {
		const source = { then(resolve) { resolve({ then(resolve) { resolve(42); } }); } };
		const replacer = (_value, js) => ({
			type: 'async-value', source, construct: () => js`({value:0})`,
			resolve: ({ target }, value) => js`${target}.value=${value}`,
			reject: ({ target }, value) => js`${target}.value=${value}`
		});
		const { root } = await drain(await unevalStream({}, replacer));
		expect(root.value).toBe(42);
	});

	test('walks async outcomes when observed to discover nested async sources', async () => {
		const outer = Promise.withResolvers();
		const inner = Promise.withResolvers();
		const value = { inner: inner.promise };
		const result = await unevalStream(outer.promise, undefined, { id: 'event-walk' });
		const target = client();
		const root = target.head(result.head);
		outer.resolve(value);
		target.block((await result.tail.next()).value);
		const resolved = await root;
		inner.resolve(42);
		target.block((await result.tail.next()).value);
		expect(await resolved.inner).toBe(42);
	});

	test('isolates a failed event from valid work in the same batch', async () => {
		const a = Promise.withResolvers();
		const b = Promise.withResolvers();
		const result = await unevalStream([a.promise, b.promise], undefined, { id: 'isolated-batch' });
		const target = client();
		const root = target.head(result.head);
		const bad = rejects(root[0], /failed to serialize asynchronous value/);
		a.resolve(() => {});
		b.resolve(9);
		target.block((await result.tail.next()).value);
		await bad;
		expect(await root[1]).toBe(9);
	});

	test('preserves cycles and nested promises first discovered in outcomes', async () => {
		const outer = Promise.withResolvers();
		const inner = Promise.withResolvers();
		const cycle = { inner: inner.promise };
		cycle.self = cycle;
		const result = await unevalStream(outer.promise, undefined, { id: 'nested-outcome' });
		const target = client();
		const root = target.head(result.head);
		outer.resolve(cycle);
		target.block((await result.tail.next()).value);
		const revived = await root;
		expect(revived.self).toBe(revived);
		inner.resolve(cycle);
		target.block((await result.tail.next()).value);
		expect(await revived.inner).toBe(revived);
	});

	test('overrides native promise handling through the replacer', async () => {
		const pending = Promise.withResolvers();
		const replacer = (value, js) => value === pending.promise && js`({overridden:true})`;
		const result = await unevalStream(pending.promise, replacer);
		const { root, blocks } = await drain(result);
		expect(root.overridden).toBe(true);
		expect(blocks).toEqual([]);
	});

	test('observes generated native Promise rejections without changing them', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/native-promise-rejection.mjs', import.meta.url));
		const result = spawnSync(process.execPath, [fixture], {
			encoding: 'utf8',
			timeout: 10_000
		});
		expect(result.signal, `fixture timed out or was terminated: ${result.stderr}`).toBe(null);
		expect(result.status, `fixture failed:\n${result.stdout}${result.stderr}`).toBe(0);
	});

	test('reports operation fallback and fatal error boundaries', async () => {
		const pending = Promise.withResolvers();
		const replacer = (_value, js) => ({
			type: 'async-value', source: pending.promise, construct: () => js`({error:void 0})`,
			resolve() { throw new Error('resolve generation'); },
			reject: ({ target }, reason) => js`${target}.error=${reason}`
		});
		const result = await unevalStream({}, replacer, { id: 'operation-fallback' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(1);
		target.block((await result.tail.next()).value);
		expect(root.error.message).toMatch(/failed to serialize asynchronous value/);

		const fatal = Promise.withResolvers();
		const broken = (_value, js) => ({
			type: 'async-value', source: fatal.promise, construct: () => js`0`,
			resolve: () => 1, reject: () => 1
		});
		const failed = await unevalStream({}, broken, { id: 'operation-fatal' });
		client().head(failed.head);
		fatal.resolve(1);
		await rejects(failed.tail.next(), /Invalid async descriptor operation/);
	});

	test('reports serialization failures through onerror without affecting the stream', async () => {
		const reports = [];
		const pending = Promise.withResolvers();
		const fn = () => {};
		const result = await unevalStream(pending.promise, undefined, {
			id: 'onerror',
			onerror(error, value) { reports.push([error, value]); }
		});
		const target = client();
		const root = target.head(result.head);
		const rejected = rejects(root, /failed to serialize asynchronous value/);
		pending.resolve(fn);
		target.block((await result.tail.next()).value);
		await rejected;
		expect(reports.length).toBe(1);
		expect(reports[0][0].message).toMatch(/Cannot stringify a function/);
		expect(reports[0][1]).toBe(fn);

		// operation-generation fallbacks report too, and a throwing onerror is ignored
		const fallback = Promise.withResolvers();
		const failures = [];
		const replacer = (_value, js) => ({
			type: 'async-value', source: fallback.promise, construct: () => js`({})`,
			resolve() { throw new Error('resolve generation'); },
			reject: () => js``
		});
		const second = await unevalStream({}, replacer, {
			id: 'onerror-fallback',
			onerror(error) { failures.push(error); throw new Error('listener'); }
		});
		client().head(second.head);
		fallback.resolve(1);
		expect(!(await second.tail.next()).done).toBeTruthy();
		expect(failures.length).toBe(1);
		expect(failures[0].message).toMatch(/resolve generation/);
		expect(await second.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('emits values settled in one flush window as one ordered batch', async () => {
		let resolvers = [];
		const promises = Array.from({ length: 10 }, () => new Promise((resolve) => resolvers.push(resolve)));
		const result = await unevalStream(promises, undefined, { id: 'macrotask-batch' });
		const target = client();
		const root = target.head(result.head);
		for (const [i, resolve] of resolvers.entries()) resolve({ i, padding: 'x'.repeat(64) });
		const blocks = [];
		for await (const block of result.tail) {
			blocks.push(block);
			target.block(block);
		}
		expect(blocks.length).toBe(1);
		const values = await Promise.all(Array.from(root));
		expect(values.map((value) => value.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test('treats non-string custom error operations as fatal', async () => {
		const ready = Promise.withResolvers();
		const replacer = (_value, js) => ({
			type: 'async-sequence',
			source: { async *[Symbol.asyncIterator]() { await ready.promise; throw new Error('source'); } },
			construct: () => js`({})`, next: () => js``, complete: () => js``, error: () => null
		});
		const result = await unevalStream({}, replacer, { id: 'non-string-error' });
		client().head(result.head);
		ready.resolve();
		await rejects(result.tail.next(), /Invalid async descriptor operation/);
	});

	test('rolls back a whole batch when a later terminal operation is fatal', async () => {
		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		let cancels = 0;
		class Job { constructor(source, broken) { this.source = source; this.broken = broken; } }
		const replacer = (value, js) => value instanceof Job && ({
			type: 'async-value', source: value.source.promise,
			construct: () => js`({values:[]})`,
			resolve: ({ target }, payload) => js`${target}.values.push(${payload})`,
			reject: value.broken ? () => 1 : ({ target }, payload) => js`${target}.values.push(${payload})`,
			cancel() { cancels++; }
		});
		const result = await unevalStream([new Job(first, false), new Job(second, true)], replacer, { id: 'batch-transaction' });
		const target = client();
		const root = target.head(result.head);
		first.resolve({ ok: true });
		second.reject(new Error('broken'));
		await rejects(result.tail.next(), /Invalid async descriptor operation/);
		expect(Array.from(root[0].values)).toEqual([]);
		expect(Array.from(root[1].values)).toEqual([]);
		expect(cancels).toBe(2);
		// like any async generator, the tail is done once it has thrown
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('freezes available sequence events into head and leaves later ones for tail', async () => {
		const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
		let pull = 0;
		const source = {
			[Symbol.asyncIterator]() { return this; },
			next() { return gates[pull++].promise; }
		};
		gates[0].resolve({ done: false, value: 1 });
		const result = await unevalStream(source, sequence_replacer(source), { id: 'frozen-sequence' });
		const target = client();
		const root = target.head(result.head);
		expect(JSON.parse(JSON.stringify(root.events))).toEqual([['next', 1]]);
		gates[1].resolve({ done: false, value: 2 });
		const next = await result.tail.next();
		expect(!next.done).toBeTruthy();
		target.block(next.value);
		expect(JSON.parse(JSON.stringify(root.events))).toEqual([['next', 1], ['next', 2]]);
		gates[2].resolve({ done: true });
		await result.tail.return();
	});

	test('closes a sequence once after an unserializable yield', async () => {
		let returns = 0;
		const source = {
			[Symbol.asyncIterator]() { return this; },
			next() { return { done: false, value: () => {} }; },
			return() { returns++; return { done: true }; }
		};
		const { root } = await drain(await unevalStream(source, sequence_replacer(source)));
		expect(root.events[0][0]).toBe('error');
		await delay();
		expect(returns).toBe(1);
	});

	test('reports a failed sequence close and keeps streaming other sources', async () => {
		const calls = [];
		const reported = [];
		const close_failure = new Error('close');
		const pending = Promise.withResolvers();
		class Source {
			constructor(name, sequence = false) {
				this.name = name;
				this.sequence = sequence;
			}
		}
		const iterable = {
			[Symbol.asyncIterator]() { return this; },
			next() { return { done: false, value: () => {} }; },
			return() { calls.push('return'); throw close_failure; }
		};
		const sequence = new Source('sequence', true);
		const value = new Source('value');
		const replacer = (source, js) => source instanceof Source && (source.sequence ? {
			type: 'async-sequence',
			source: iterable,
			construct: () => js`({events:[]})`,
			next: ({ target }, v) => js`${target}.events.push(["next",${v}])`,
			complete: ({ target }, v) => js`${target}.events.push(["complete",${v}])`,
			error: ({ target }, v) => js`${target}.events.push(["error",${v}])`,
			cancel() { calls.push('sequence'); }
		} : {
			type: 'async-value', source: pending.promise, construct: () => js`({values:[]})`,
			resolve: ({ target }, v) => js`${target}.values.push(${v})`, reject: () => js``,
			cancel() { calls.push('value'); }
		});
		const result = await unevalStream([sequence, value], replacer, {
			id: 'close-failure',
			onerror: (error, source) => reported.push([error, source])
		});
		const target = client();
		const root = target.head(result.head);
		// the unserializable yield failed the sequence in the head window; its close failure is
		// reported but the stream stays healthy
		expect(calls).toEqual(['return']);
		expect(reported.length).toBe(2);
		expect(reported[1][0]).toBe(close_failure);
		expect(reported[1][1]).toBe(iterable);
		expect(root[0].events.length).toBe(1);
		expect(root[0].events[0][0]).toBe('error');
		pending.resolve(1);
		for await (const block of result.tail) target.block(block);
		expect(Array.from(root[1].values)).toEqual([1]);
		expect(calls).toEqual(['return']);
		expect(!Object.hasOwn(target.context.__d, 'close-failure')).toBeTruthy();
	});

	test('cancels all sources and reports the first cleanup failure', async () => {
		const calls = [];
		class Job { constructor(name) { this.name = name; } }
		const replacer = (value, js) => value instanceof Job && ({
			type: 'async-value', source: new Promise(() => {}), construct: () => js`0`,
			resolve: () => js``, reject: () => js``,
			async cancel() { calls.push(value.name); throw new Error(value.name); }
		});
		const result = await unevalStream([new Job('first'), new Job('second')], replacer);
		await rejects(result.tail.return(), /first/);
		expect(calls).toEqual(['first', 'second']);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		expect(await result.tail.return()).toEqual({ done: true, value: undefined });
	});

	test('aborts a pending tail consumer and ignores late source work', async () => {
		const controller = new AbortController();
		const pending = Promise.withResolvers();
		let cancelled = 0;
		class Job {}
		const replacer = (_value, js) => ({
			type: 'async-value', source: pending.promise, construct: () => js`0`,
			resolve: () => js``, reject: () => js``, cancel() { cancelled++; }
		});
		const reason = new Error('stop');
		const result = await unevalStream(new Job(), replacer, { signal: controller.signal });
		const next = result.tail.next();
		controller.abort(reason);
		await rejects(next, reason);
		expect(cancelled).toBe(1);
		pending.resolve(1);
		await delay();
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('removes completed entries but preserves the empty table and concurrent sessions', async () => {
		const lone = Promise.withResolvers();
		const single = await unevalStream(lone.promise, undefined, { id: 'lone' });
		const target = client();
		target.head(single.head);
		lone.resolve(1);
		target.block((await single.tail.next()).value);
		expect(!Object.hasOwn(target.context.__d, 'lone')).toBeTruthy();
		expect(Object.getPrototypeOf(target.context.__d)).toBe(null);

		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		const a = await unevalStream(first.promise, undefined, { id: 'shared-a' });
		const b = await unevalStream(second.promise, undefined, { id: 'shared-b' });
		target.head(a.head);
		target.head(b.head);
		first.resolve(1);
		target.block((await a.tail.next()).value);
		expect(Object.hasOwn(target.context.__d, 'shared-b')).toBeTruthy();
		second.resolve(2);
		target.block((await b.tail.next()).value);
		expect(!Object.hasOwn(target.context.__d, 'shared-b')).toBeTruthy();
		expect(Object.getPrototypeOf(target.context.__d)).toBe(null);
	});

	test('isolates dangerous ids in the null-prototype session table', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'inherited' });
		const target = client();
		target.head(result.head);
		expect(Object.hasOwn(target.context.__d, 'inherited')).toBeTruthy();
		expect(Object.getPrototypeOf(target.context.__d)).toBe(null);
		await result.tail.return();
	});

	test('supports assignable custom table member scopes and retains them after cleanup', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'custom', scope: 'globalThis.state.streams' });
		const target = client({ state: {} });
		const root = target.head(result.head);
		expect(Object.getPrototypeOf(target.context.state.streams)).toBe(null);
		expect(Object.hasOwn(target.context.state.streams, 'custom')).toBeTruthy();
		pending.resolve(1);
		target.block((await result.tail.next()).value);
		expect(await root).toBe(1);
		expect(!Object.hasOwn(target.context.state.streams, 'custom')).toBeTruthy();
		expect(Object.getPrototypeOf(target.context.state.streams)).toBe(null);
	});

	test('escapes ids keys values and rejection reasons in generated protocol source', async () => {
		const text = '</script>\n\u2028';
		const pending = Promise.withResolvers();
		const result = await unevalStream({ [text]: pending.promise }, undefined, { id: text });
		expect(result.head).not.toMatch(/<\/script>/);
		const target = client();
		const root = target.head(result.head);
		pending.reject(text);
		const rejection = rejects(root[text], text);
		const block = (await result.tail.next()).value;
		expect(block).not.toMatch(/<\/script>/);
		target.block(block);
		await rejection;
	});

	test('makes exhausted tails one-shot and returns itself as async iterator', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'one-shot-tail' });
		expect(result.tail[Symbol.asyncIterator]()).toBe(result.tail);
		client().head(result.head);
		pending.resolve(1);
		expect(!(await result.tail.next()).done).toBeTruthy();
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		expect(await result.tail.return()).toEqual({ done: true, value: undefined });
	});

	test('matches synchronous parity for supported scalar and container categories', async () => {
		const null_object = Object.assign(Object.create(null), { value: 1 });
		const values = {
			boxed: [Object(1), Object('x'), Object(true), Object(2n)],
			date: new Date(123), regexp: /a+/gi,
			url: new URL('https://example.com/a?b=1'), params: new URLSearchParams('a=1&a=2'),
			null_object, empty_set: new Set(), empty_map: new Map()
		};
		const { root } = await drain(await unevalStream(values), client({ URL, URLSearchParams }));
		expect(Object.getPrototypeOf(root.null_object)).toBe(null);
		expect(root.date.getTime()).toBe(123);
		expect(root.regexp.source).toBe('a+');
		expect(root.regexp.flags).toBe('gi');
		expect(root.url.href).toBe(values.url.href);
		expect(root.params.toString()).toBe('a=1&a=2');
		expect(root.boxed[0].valueOf()).toBe(1);
		expect(root.boxed[1].valueOf()).toBe('x');
		expect(root.boxed[2].valueOf()).toBe(true);
		expect(root.boxed[3].valueOf()).toBe(2n);
		expect(root.empty_set.size).toBe(0);
		expect(root.empty_map.size).toBe(0);
	});

	test('matches parity for typed arrays DataView subviews and repeated views', async () => {
		const buffer = new ArrayBuffer(16);
		new Uint8Array(buffer).set([1, 2, 3, 4]);
		const view = new Uint16Array(buffer, 2, 3);
		const data = new DataView(buffer, 1, 5);
		const { root } = await drain(await unevalStream({ buffer, view, repeated: view, data }));
		expect(root.view).toBe(root.repeated);
		expect(root.view.buffer).toBe(root.buffer);
		expect(root.data.buffer).toBe(root.buffer);
		expect(root.view.byteOffset).toBe(2);
		expect(root.data.byteLength).toBe(5);
		expect(Array.from(new Uint8Array(root.buffer))).toEqual(Array.from(new Uint8Array(buffer)));
	});

	test('rejects unsupported graphs at the initial error boundary', async () => {
		const symbolic = { [Symbol('x')]: 1 };
		const proto = Object.create(null);
		Object.defineProperty(proto, '__proto__', { value: 1, enumerable: true });
		for (const value of [() => {}, Symbol('x'), new WeakMap(), symbolic, proto]) {
			await rejects(unevalStream(value), /Cannot stringify/);
		}
	});

	test('delivers a large single-use payload through one executable block', async () => {
		const pending = Promise.withResolvers();
		const payload = { rows: Array.from({ length: 100 }, (_, i) => ({ i, value: `value-${i}` })) };
		const result = await unevalStream({ pending: pending.promise }, undefined, { id: 'large-guardrail' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(payload);
		const block = (await result.tail.next()).value;
		const message = `raw=${block.length}`;
		// a 100-row payload must stay a compact literal batch, not an expansion regression
		expect(block.length, message).toBeLessThan(3200);
		target.block(block);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		const received = await root.pending;
		expect(received.rows.length).toBe(100);
		expect(received.rows[42]).toEqual({ i: 42, value: 'value-42' });
	});

	test('reuses one anchor for a sequence of repeated identities', async () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ i }));
		const result = await unevalStream(
			(async function* () {
				for (let i = 0; i < 12; i += 1) {
					await delay();
					yield { self: items[i], prev: i > 0 ? items[i - 1] : null };
				}
			})(),
			undefined,
			{ id: 'implicit-anchors' }
		);
		const target = client();
		const root = target.head(result.head);
		let source = result.head;
		for await (const block of result.tail) {
			source += block;
			target.block(block);
		}
		// identity is preserved whether an anchor is explicit or implicit
		const seen = [];
		for await (const entry of root) seen.push(entry);
		expect(seen.length).toBe(12);
		for (let i = 1; i < 12; i += 1) expect(seen[i].prev).toBe(seen[i - 1].self);
		// the emitted source stays compact instead of re-anchoring every outcome
		expect(source.length, `raw=${source.length}`).toBeLessThan(3200);
	});

	test('does not re-anchor an identity repeated by a sequence', async () => {
		const hold = Promise.withResolvers();
		const repeated = { value: 1 };
		const source = {
			async *[Symbol.asyncIterator]() {
				for (let i = 0; i < 12; i += 1) yield repeated;
			}
		};
		const result = await unevalStream({ source, hold: hold.promise }, undefined, { id: 'repeated-root' });
		const target = client();
		const root = target.head(result.head);
		const values = [];
		let emitted = result.head.length;
		for (let i = 0; i < 12; i += 1) {
			const next = root.source.next();
			if (i > 0) {
				const block = (await result.tail.next()).value;
				emitted += block.length;
				target.block(block);
			}
			const item = await next;
			values.push(item.value);
		}
		const complete = root.source.next();
		target.block((await result.tail.next()).value);
		expect((await complete).done).toBe(true);
		for (const value of values) expect(value).toBe(values[0]);
		// repeating one identity stays compact: no new anchors or copies per outcome
		expect(emitted, `emitted=${emitted}`).toBeLessThan(result.head.length * 2);
		hold.resolve('done');
		for await (const block of result.tail) target.block(block);
		expect(await root.hold).toBe('done');
	});

	test('keeps dense anchors for unique roots interleaved with repeated roots', async () => {
		const repeated = { repeated: true };
		const unique = Array.from({ length: 9 }, (_, index) => ({ index }));
		const outcomes = [repeated, unique[0], repeated, unique[1], unique[2], repeated, ...unique.slice(3), repeated];
		const source = {
			async *[Symbol.asyncIterator]() {
				for (const value of outcomes) {
					await delay();
					yield value;
				}
			}
		};
		const result = await unevalStream(source, undefined, { id: 'dense-repeated-roots' });
		const target = client();
		const root = target.head(result.head);
		const values = [];
		const reading = (async () => {
			for await (const value of root) values.push(value);
		})();
		let emitted = result.head;
		for await (const block of result.tail) {
			emitted += block;
			target.block(block);
		}
		await reading;
		expect(values.length).toBe(outcomes.length);
		expect(values[0]).toBe(values[2]);
		expect(values[0]).toBe(values[5]);
		expect(values[0]).toBe(values[values.length - 1]);
		for (let i = 0; i < unique.length; i += 1) {
			const revived = values.find((value) => value.index === i);
			expect(revived).toBeTruthy();
			for (let j = 0; j < i; j += 1) expect(revived !== values.find((value) => value.index === j)).toBeTruthy();
		}
	});

	test('reconstructs a shared identity through its captured path', async () => {
		const pending = Promise.withResolvers();
		const shared = {};
		const root_value = {
			veryLongPropertyName: { anotherLongPropertyName: shared },
			x: shared,
			pending: pending.promise
		};
		const result = await unevalStream(root_value, undefined, { id: 'shortest-path' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve(shared);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(await root.pending).toBe(root.x);
		expect(await root.pending).toBe(root.veryLongPropertyName.anotherLongPropertyName);
	});

	test('keeps repeated identities distinct from unique ones', async () => {
		for (const [shape, payload_count] of [
			[{ deeplyNestedPropertyName: { anotherLongPropertyName: {} } }, 3],
			[{ x: {} }, 2]
		]) {
			const pending = Promise.withResolvers();
			const key = Object.keys(shape)[0];
			const inner = Object.values(shape)[0];
			const inner_key = Object.keys(inner)[0];
			const shared = inner[inner_key];
			const result = await unevalStream({ ...shape, pending: pending.promise }, undefined, { id: 'profitable-slot' });
			const target = client();
			const root = target.head(result.head);
			pending.resolve(Array.from({ length: payload_count }, () => shared));
			const block = (await result.tail.next()).value;
			target.block(block);
			const received = await root.pending;
			expect(received.length).toBe(payload_count);
			for (const value of received) expect(value).toBe(root[key][inner_key]);
		}
	});

	test('keeps equal-length alias encounter order across the slot digit boundary', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}
		const pending = Promise.withResolvers();
		const first = {};
		const other = {};
		const opaque = Array.from({ length: 9 }, (_, index) => new Wrapper({ index }));
		const result = await unevalStream({
			opaque,
			first: { veryLongPropertyName: first },
			other: { veryLongPropertyName: other },
			pending: pending.promise
		}, (value, js) => value instanceof Wrapper && js`({value:${value.value}})`, { id: 'alias-digit-boundary' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve([other, other, other, first, first, first]);
		const block = (await result.tail.next()).value;
		target.block(block);
		const values = await root.pending;
		expect(values[0]).toBe(root.other.veryLongPropertyName);
		expect(values[3]).toBe(root.first.veryLongPropertyName);
	});

	test('composes descriptor references without replacing similar source text', async () => {
		const pending = Promise.withResolvers();
		const marker = '"0"';
		const result = await unevalStream(pending.promise, (value, js) => value === pending.promise && ({
			type: 'async-value',
			source: pending.promise,
			construct: (capture) => {
				return js`new Promise((resolve,reject)=>{${capture(js`[resolve,reject]`)}})`;
			},
			resolve: ({ control }, payload) => js`globalThis.marker=${marker};${control}[0](${payload})`,
			reject: ({ control }, reason) => js`${control}[1](${reason})`
		}));
		const target = client();
		const promise = target.head(result.head);
		pending.resolve(1);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(globalThis.marker).toBe(undefined);
		expect(target.context.marker).toBe(marker);
		expect(await promise).toBe(1);
	});

	test('preserves Map and Set element identity across asynchronous regions', async () => {
		const a = Promise.withResolvers();
		const b = Promise.withResolvers();
		const c = Promise.withResolvers();
		const inner = { x: 1 };
		const result = await unevalStream({ a: a.promise, b: b.promise, c: c.promise }, undefined, { id: 'async-collections' });
		const target = client();
		const root = target.head(result.head);
		a.resolve(new Map([['k', inner]]));
		target.block((await result.tail.next()).value);
		b.resolve(new Set([inner]));
		target.block((await result.tail.next()).value);
		c.resolve(inner);
		target.block((await result.tail.next()).value);
		const revived = await root.c;
		expect((await root.a).get('k')).toBe(revived);
		expect(Array.from(await root.b)[0]).toBe(revived);
	});

	test('preserves custom replacer child identity across asynchronous regions', async () => {
		class Wrap {
			constructor(value) {
				this.value = value;
			}
		}
		const a = Promise.withResolvers();
		const b = Promise.withResolvers();
		const inner = { x: 1 };
		const result = await unevalStream(
			{ a: a.promise, b: b.promise },
			(value, js) => (value instanceof Wrap ? js`{wrapped:${value.value}}` : undefined),
			{ id: 'async-custom-child' }
		);
		const target = client();
		const root = target.head(result.head);
		a.resolve(new Wrap(inner));
		target.block((await result.tail.next()).value);
		b.resolve(inner);
		target.block((await result.tail.next()).value);
		expect((await root.a).wrapped).toBe(await root.b);
	});

	test('folds values settled inside the initial flush window into the head', async () => {
		let resolvers = [];
		const promises = Array.from({ length: 3 }, () => new Promise((resolve) => resolvers.push(resolve)));
		const result = await unevalStream(promises, undefined, { id: 'head-batch' });
		const target = client();
		const root = target.head(result.head);
		// settle everything synchronously before the first flush runs: the
		// documented host-scheduling window may fold these into the head
		for (const [i, resolve] of resolvers.entries()) resolve({ i });
		const blocks = [];
		for await (const block of result.tail) {
			blocks.push(block);
			target.block(block);
		}
		const values = await Promise.all(Array.from(root));
		expect(values.map((value) => value.i)).toEqual([0, 1, 2]);
	});

	test('defines the sequence runtime before hoisted declarations that use it', async () => {
		async function* first() {
			yield 1;
		}
		async function* second() {
			yield 2;
		}
		const seq1 = first();
		const seq2 = second();
		// seq1 is discovered first but emitted inline deep in the tree; seq2 is repeated,
		// so it hoists into a declaration that runs before the root literal
		const result = await unevalStream({ a: { x: seq1 }, b: seq2, b2: seq2 }, undefined, { id: 'runtime-order' });
		const { root, client: target } = await drain(result);
		expect(root.b).toBe(root.b2);
		expect((await root.a.x.next()).value).toBe(1);
		expect((await root.b.next()).value).toBe(2);
	});

	test('shares pending promise runtime cost across several pending promises', async () => {
		const single = await unevalStream(new Promise(() => {}), undefined, { id: 'single-promise' });
		await single.tail.return();
		const multiple = await unevalStream(
			[new Promise(() => {}), new Promise(() => {}), new Promise(() => {})],
			undefined,
			{ id: 'multi-promise' }
		);
		// three pending promises must reuse shared runtime: the head stays close
		// to the single-promise size instead of shipping three copies
		expect(multiple.head.length, `single=${single.head.length} multiple=${multiple.head.length}`).toBeLessThan(300);
		await multiple.tail.return();
	});

	test('delivers each settlement as its own block while reusing shared runtime', async () => {
		const settlers = [];
		const promises = Array.from({ length: 3 }, () => new Promise((resolve) => settlers.push(resolve)));
		const result = await unevalStream(promises, undefined, { id: 'settle-helper' });
		const target = client();
		const root = target.head(result.head);
		const blocks = [];
		for (const [i, settle] of settlers.entries()) {
			settle({ i });
			// awaiting each delivery keeps the settlements in separate batches
			blocks.push((await result.tail.next()).value);
		}
		for (const block of blocks) target.block(block);
		expect(blocks.length).toBe(3);
		expect(JSON.parse(JSON.stringify(await Promise.all(Array.from(root))))).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
		expect(target.context.__d && Object.keys(target.context.__d).length).toBe(0);
	});

	test('delivers a single-use outcome through one executable block', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'inline-anchor' });
		const target = client();
		const root = target.head(result.head);
		pending.resolve({ value: 42 });
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		expect({ ...(await root) }).toEqual({ value: 42 });
	});

	test('protects complete custom construct capture and operation boundaries from line comments', async () => {
		class Job {
			constructor(name) {
				this.name = name;
				this.ready = Promise.withResolvers();
			}
		}
		const folded = new Job('folded');
		folded.ready.promise = Promise.resolve('head // string');
		const first = new Job('first');
		const second = new Job('second');
		const failed = new Job('failed');
		const replacer = (value, js) => {
			if (!(value instanceof Job)) return;
			const partial = js`{name:${value.name},events:[]`;
			return {
				type: 'async-value',
				source: value.ready.promise,
				construct: (capture) => js`(()=>{const local=${partial}};new Promise((resolve,reject)=>{${capture(js`[resolve,reject] // capture`)}});return local})() // construct`,
				resolve: ({ target }, payload) => {
					if (value === failed) throw new Error('use fallback');
					return js`${target}.events.push(${payload}) // resolve`;
				},
				reject: ({ target }, reason) => js`${target}.events.push(${reason}) /* block */ // reject`
			};
		};
		const result = await unevalStream({ folded, first, second, failed }, replacer, {
			id: 'line-comments',
			onerror() {}
		});
		const target = client();
		const root = target.head(result.head);
		expect(Array.from(root.folded.events)).toEqual(['head // string']);
		first.ready.resolve('first');
		second.ready.resolve('second');
		const batch = (await result.tail.next()).value;
		target.block(batch);
		failed.ready.resolve('ignored');
		const fallback = (await result.tail.next()).value;
		target.block(fallback);
		expect(Array.from(root.first.events)).toEqual(['first']);
		expect(Array.from(root.second.events)).toEqual(['second']);
		expect(root.failed.events.length).toBe(1);
		expect(root.failed.events[0].message).toMatch(/failed to serialize asynchronous value/);
		expect(result.head + batch + fallback).toMatch(/\/\/ (?:capture|construct|resolve|reject)\n/);
		expect(target.context.__d && Object.keys(target.context.__d).length).toBe(0);
	});

});
