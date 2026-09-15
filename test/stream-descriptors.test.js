import { describe, test, expect } from 'vitest';
import { DevalueError, unevalStream } from '../index.js';
import { client } from './helpers/stream.js';

describe('unevalStream descriptor holes', () => {

	async function rejected(promise) {
		try { await promise; } catch (error) { return error; }
		expect.unreachable('expected rejection');
	}

	function invalid_graph_value(label) {
		const bad = function invalid_descriptor_value() {};
		return { bad, value: { deep: { [label]: bad } } };
	}

	function assert_descriptor_diagnostic(error, context, bad, root, path) {
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toMatch(new RegExp(`${context.replace(/[()]/g, '\\$&')}, template hole 1: received an object`));
		expect(error.cause).toBeInstanceOf(DevalueError);
		expect(error.cause.value).toBe(bad);
		expect(error.cause.root).toBe(root);
		expect(error.cause.path).toBe(path);
	}

	test('serializes graph values in construct and reachable capture expressions', async () => {
		const ready = Promise.withResolvers();
		const shared = { name: 'shared' };
		const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
		const view = new Uint16Array(buffer);
		const config = {
			shared,
			array: [shared],
			map: new Map([[shared, view]]),
			set: new Set([shared]),
			view,
			buffer
		};
		let construct_calls = 0;
		let discarded_then_reads = 0;
		const job = {};
		const discarded = { get then() { discarded_then_reads++; return () => {}; } };
		const result = await unevalStream({ shared, job }, (value, js) => value === job && ({
			type: 'async-value',
			source: ready.promise,
			construct: (capture) => {
				construct_calls++;
				js`${discarded}`;
				return js`({config:${config},control:${capture(js`[${shared}]`)},value:null})`;
			},
			resolve: () => js``,
			reject: () => js``
		}), { id: 'descriptor-construct-holes' });
		const target = client();
		const root = target.head(result.head);
		expect(construct_calls).toBe(1);
		expect(discarded_then_reads).toBe(0);
		expect(root.job.config.shared).toBe(root.shared);
		expect(root.job.config.array[0]).toBe(root.shared);
		expect(Array.from(root.job.config.set)[0]).toBe(root.shared);
		expect(Array.from(root.job.config.map.keys())[0]).toBe(root.shared);
		expect(root.job.config.map.get(root.shared)).toBe(root.job.config.view);
		expect(root.job.config.view.buffer).toBe(root.job.config.buffer);
		expect(root.job.control[0]).toBe(root.shared);
		ready.resolve();
		for await (const block of result.tail) target.block(block);
	});

	test('never reads unknown descriptor fields and composes captured controls into operations', async () => {
		const property = 'throwing';
		const ready = Promise.withResolvers();
		const keepalive = Promise.withResolvers();
		const job = {};
		let reads = 0;
		const result = await unevalStream({ job, keepalive: keepalive.promise }, (value, js) => {
			if (value !== job) return;
			const descriptor = {
				type: 'async-value',
				source: ready.promise,
				construct: (capture) => js`({control:${capture(js`[]`)},value:null})`,
				resolve({ target, control }, outcome) {
					return js`globalThis.control_matched=${control}===${target}.control;${target}.value=${outcome}`;
				},
				reject: () => js``
			};
			Object.defineProperty(descriptor, 'manages_pending', {
				get() { reads++; throw new Error('unknown fields must not be read'); }
			});
			return descriptor;
		}, { id: `pending-${property}` });
		const target = client();
		const root = target.head(result.head);
		ready.resolve(7);
		target.block((await result.tail.next()).value);
		expect(root.job.value).toBe(7);
		expect(target.context.control_matched).toBe(true);
		expect(Object.hasOwn(target.context.__d, `pending-${property}`)).toBeTruthy();
		expect(reads).toBe(0);
		keepalive.resolve();
		for await (const block of result.tail) target.block(block);
		expect(Object.hasOwn(target.context.__d, `pending-${property}`)).toBe(false);
	});

	test('retains custom sequence controls through next and completion', async () => {
		const first = Promise.withResolvers();
		const complete = Promise.withResolvers();
		const keepalive = Promise.withResolvers();
		const iterator = {
			pulls: 0,
			next() { return ++this.pulls === 1 ? first.promise : complete.promise; }
		};
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const job = {};
		const id = 'pending-sequence';
		const result = await unevalStream({ job, keepalive: keepalive.promise }, (value, js) => value === job && ({
			type: 'async-sequence', source,
			construct: (capture) => js`({control:${capture(js`[]`)},events:[]})`,
			next: ({ target, control }, outcome) => js`${target}.events.push(${control}===${target}.control,${outcome})`,
			complete: ({ target, control }, outcome) => js`${target}.events.push(${control}===${target}.control,${outcome})`,
			error: () => js``
		}), { id });
		const target = client();
		const root = target.head(result.head);
		first.resolve({ done: false, value: 1 });
		target.block((await result.tail.next()).value);
		complete.resolve({ done: true, value: 2 });
		target.block((await result.tail.next()).value);
		expect(Array.from(root.job.events)).toEqual([true, 1, true, 2]);
		keepalive.resolve();
		for await (const block of result.tail) target.block(block);
		expect(!Object.hasOwn(target.context.__d, id)).toBeTruthy();
	});

	test('keeps called but discarded captures unreachable', async () => {
		const ready = Promise.withResolvers();
		const keepalive = Promise.withResolvers();
		const job = {};
		let control;
		const result = await unevalStream({ job, keepalive: keepalive.promise }, (value, js) => value === job && ({
			type: 'async-value', source: ready.promise,
			construct(capture) { capture(js`[${new Promise(() => {})}]`); return js`({value:null})`; },
			resolve(reference, outcome) { control = reference.control; return js`${reference.target}.value=${outcome}`; },
			reject: () => js``
		}), { id: 'discarded-capture' });
		const target = client();
		const root = target.head(result.head);
		ready.resolve(1);
		target.block((await result.tail.next()).value);
		expect(control).toBe(undefined);
		expect(root.job.value).toBe(1);
		keepalive.resolve();
		for await (const block of result.tail) target.block(block);
	});

	test('populates sparse and null-object holes before repeated descriptor construction in every value region', async () => {
		class Job {
			constructor(value) {
				this.value = value;
				this.ready = new Promise(() => {});
			}
		}
		for (const mode of ['head', 'folded', 'outcome']) {
			const null_child = Object.assign(Object.create(null), { x: 42 });
			const sparse_child = Array(3);
			sparse_child[1] = null_child;
			const job = new Job({ items: sparse_child });
			const graph = { null_child, sparse_child, jobs: [job, job] };
			const gate = Promise.withResolvers();
			const value = mode === 'head' ? graph : mode === 'folded' ? Promise.resolve(graph) : gate.promise;
			let constructions = 0;
			const context = client();
			context.context.construct = (value) => {
				constructions++;
				return { value, observed: value.items[1].x };
			};
			const result = await unevalStream(value, (value, js) => value instanceof Job && ({
				type: 'async-value',
				source: value.ready,
				construct: () => js`construct(${value.value})`,
				resolve: () => js``,
				reject: () => js``
			}), { id: `descriptor-construction-readiness-${mode}` });
			let root = context.head(result.head);
			if (mode === 'outcome') {
				gate.resolve(graph);
				context.block((await result.tail.next()).value);
			}
			if (mode !== 'head') root = await root;
			expect(root.jobs[0]).toBe(root.jobs[1]);
			expect(root.jobs[0].value.items).toBe(root.sparse_child);
			expect(root.sparse_child[1]).toBe(root.null_child);
			expect(root.jobs[0].observed).toBe(42);
			expect(constructions).toBe(1);
			await result.tail.return();
		}
	});

	test('populates operation-hole children before nested descriptor construction', async () => {
		class Job {
			constructor(source, value) {
				this.source = source;
				this.value = value;
			}
		}
		const outer_ready = Promise.withResolvers();
		const child_ready = new Promise(() => {});
		const null_child = Object.assign(Object.create(null), { x: 42 });
		const sparse_child = Array(3);
		sparse_child[1] = null_child;
		const nested = new Job(child_ready, { items: sparse_child });
		const outer = new Job(outer_ready.promise, null);
		let constructions = 0;
		const context = client();
		context.context.construct = (value) => {
			constructions++;
			return { value, observed: value.items[1].x };
		};
		const result = await unevalStream(outer, (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: value.source,
			construct: () => value === outer ? js`({values:null})` : js`construct(${value.value})`,
			resolve: ({ target }) => value === outer ? js`${target}.values=[${sparse_child},${null_child},${nested},${nested}]` : js``,
			reject: () => js``
		}), { id: 'descriptor-operation-construction-readiness' });
		const root = context.head(result.head);
		outer_ready.resolve();
		context.block((await result.tail.next()).value);
		expect(root.values[2]).toBe(root.values[3]);
		expect(root.values[2].value.items).toBe(root.values[0]);
		expect(root.values[0][1]).toBe(root.values[1]);
		expect(root.values[2].observed).toBe(42);
		expect(constructions).toBe(1);
		await result.tail.return();
	});

	test('groups the complete descriptor construction expression after lowering holes', async () => {
		const ready = Promise.withResolvers();
		const job = {};
		const config = { value: 2 };
		const result = await unevalStream(job, (value, js) => value === job && ({
			type: 'async-value', source: ready.promise,
			construct: () => js`0,{config:${config}}`,
			resolve: () => js``, reject: () => js``
		}));
		const root = client().head(result.head);
		expect(root.config.value).toBe(2);
		ready.resolve();
		for await (const _block of result.tail) {}
	});

	test('materializes repeated operation holes once and preserves head/payload identity', async () => {
		const ready = Promise.withResolvers();
		const shared = { value: 1 };
		const job = {};
		const result = await unevalStream({ shared, job }, (value, js) => value === job && ({
			type: 'async-value',
			source: ready.promise,
			construct: () => js`({values:null,get:null})`,
			resolve: ({ target }, payload) => js`${target}.values=[${shared},${shared},${payload}];${target}.get=()=>${shared}`,
			reject: () => js``
		}), { id: 'descriptor-operation-holes' });
		const target = client();
		const root = target.head(result.head);
		ready.resolve(shared);
		for await (const block of result.tail) target.block(block);
		expect(root.job.values[0]).toBe(root.shared);
		expect(root.job.values[0]).toBe(root.job.values[1]);
		expect(root.job.values[0]).toBe(root.job.values[2]);
		expect(root.job.get()).toBe(root.shared);
	});

	test('gives nested constructor descriptors distinct controls', async () => {
		class Job { constructor(name) { this.name = name; this.ready = Promise.withResolvers(); } }
		const inner = new Job('inner');
		const outer = new Job('outer');
		outer.child = inner;
		const result = await unevalStream(outer, (value, js) => value instanceof Job && ({
			type: 'async-value', source: value.ready.promise,
			construct: (capture) => js`({name:${value.name},control:${capture(js`[]`)},child:${value.child ?? null}})`,
			resolve: ({ target, control }) => js`${target}.control_matched=(${control}===${target}.control)`,
			reject: () => js``
		}), { id: 'nested-constructor-indices' });
		const target = client();
		const root = target.head(result.head);
		expect(root.name).toBe('outer');
		expect(root.child.name).toBe('inner');
		outer.ready.resolve();
		inner.ready.resolve();
		for await (const block of result.tail) target.block(block);
		// each descriptor's control composes with its own target, and unrelated
		// descriptors do not alias each other's controls
		expect(root.control_matched).toBe(true);
		expect(root.child.control_matched).toBe(true);
		expect(root.control).not.toBe(root.child.control);
	});

	test('serializes next complete reject and error holes', async () => {
		for (const phase of ['reject', 'next', 'complete', 'error']) {
			const gate = Promise.withResolvers();
			const hole = { phase };
			const job = {};
			const sequence = phase === 'next' || phase === 'complete' || phase === 'error';
			const source = sequence ? {
				[Symbol.asyncIterator]() { return this; },
				next() { return gate.promise; }
			} : gate.promise;
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: sequence ? 'async-sequence' : 'async-value', source,
				construct: () => js`({value:null})`,
				resolve: () => js``,
				reject: ({ target }) => js`${target}.value=${hole}`,
				next: ({ target }) => js`${target}.value=${hole}`,
				complete: ({ target }) => js`${target}.value=${hole}`,
				error: ({ target }) => js`${target}.value=${hole}`
			}), { id: `descriptor-${phase}-hole` });
			const target = client();
			const root = target.head(result.head);
			if (phase === 'reject' || phase === 'error') gate.reject('reason');
			else gate.resolve({ done: phase === 'complete', value: 1 });
			const block = await result.tail.next();
			target.block(block.value);
			expect(root.value.phase).toBe(phase);
			if (phase === 'next') await result.tail.return();
		}
	});

	test('reports invalid operation data then lowers a valid fallback hole', async () => {
		const ready = Promise.withResolvers();
		const fallback = { ok: true };
		const reports = [];
		const job = {};
		const result = await unevalStream(job, (value, js) => value === job && ({
			type: 'async-value', source: ready.promise,
			construct: () => js`({value:null})`,
			resolve: () => js`${() => {}}`,
			reject: ({ target }) => js`${target}.value=${fallback}`
		}), { id: 'descriptor-fallback-hole', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		ready.resolve(1);
		target.block((await result.tail.next()).value);
		expect(reports.length).toBe(1);
		expect(reports[0].message).toMatch(/resolve\(\), template hole 1: received a function/);
		expect(root.value.ok).toBe(true);
	});

	for (const mode of ['construct', 'capture']) {
		test(`preserves finalized graph diagnostics for nested ${mode} holes`, async () => {
			const { bad, value: config } = invalid_graph_value('bad');
			const job = {};
			const root = { job };
			const error = await rejected(unevalStream(root, (value, js) => value === job && ({
				type: 'async-value',
				source: new Promise(() => {}),
				construct: (capture) => mode === 'construct'
					? js`({config:${config}})`
					: js`({control:${capture(js`[${config}]`)}})`,
				resolve: () => js``,
				reject: () => js``
			})));
			assert_descriptor_diagnostic(error, `async descriptor ${mode}()`, bad, root, '.job.deep.bad');
		});
	}

	test('preserves descriptor diagnostics nested in an asynchronous payload region', async () => {
		const outcome = Promise.withResolvers();
		const { bad, value: config } = invalid_graph_value('bad');
		const job = {};
		const payload = { job };
		const reports = [];
		const result = await unevalStream(outcome.promise, (value, js) => value === job && ({
			type: 'async-value', source: new Promise(() => {}),
			construct: () => js`({config:${config}})`,
			resolve: () => js``, reject: () => js``
		}), { onerror: (error) => reports.push(error) });
		outcome.resolve(payload);
		await result.tail.next();
		expect(reports.length).toBe(1);
		assert_descriptor_diagnostic(reports[0], 'async descriptor construct()', bad, outcome.promise, '.job.deep.bad');
	});

	for (const phase of ['resolve', 'next', 'complete']) {
		test(`preserves operation diagnostics and redacts recovered ${phase} failures from client source`, async () => {
			const gate = Promise.withResolvers();
			const { bad, value: invalid } = invalid_graph_value('bad');
			const reports = [];
			const job = {};
			const sequence = phase !== 'resolve';
			const source = sequence ? {
				[Symbol.asyncIterator]() { return this; },
				next() { return gate.promise; }
			} : gate.promise;
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: sequence ? 'async-sequence' : 'async-value',
				source,
				construct: () => js`({error:null})`,
				resolve: () => js`${invalid}`,
				next: () => js`${invalid}`,
				complete: () => js`${invalid}`,
				reject: ({ target }, error) => js`${target}.error=${error}`,
				error: ({ target }, error) => js`${target}.error=${error}`
			}), { onerror: (error) => reports.push(error) });
			const target = client();
			const root = target.head(result.head);
			gate.resolve(sequence ? { done: phase === 'complete', value: 1 } : 1);
			const block = await result.tail.next();
			expect(block.done).toBe(false);
			expect(block.value).not.toMatch(/invalid_descriptor_value|Cannot stringify a function|\.deep\.bad/);
			target.block(block.value);
			expect(reports.length).toBe(1);
			assert_descriptor_diagnostic(reports[0], `async descriptor ${phase}()`, bad, job, '.deep.bad');
			expect(root.error.message).toMatch(/failed to serialize asynchronous value/);
			expect(root.error.message).not.toMatch(/Cannot stringify|deep|bad/);
			if (phase === 'next') await result.tail.return();
		});
	}

	for (const mode of ['reject', 'error', 'fallback reject', 'fallback error']) {
		test(`preserves finalized diagnostics for terminal ${mode} holes`, async () => {
			const gate = Promise.withResolvers();
			const { bad, value: invalid } = invalid_graph_value('bad');
			const job = {};
			const sequence = mode.endsWith('error');
			const fallback = mode.startsWith('fallback');
			const source = sequence ? {
				[Symbol.asyncIterator]() { return this; },
				next() { return gate.promise; }
			} : gate.promise;
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: sequence ? 'async-sequence' : 'async-value',
				source,
				construct: () => js`({})`,
				resolve: () => fallback ? js`${() => {}}` : js``,
				next: () => fallback ? js`${() => {}}` : js``,
				complete: () => js``,
				reject: () => js`${invalid}`,
				error: () => js`${invalid}`
			}));
			const pending = result.tail.next();
			if (fallback) gate.resolve(sequence ? { done: false, value: 1 } : 1);
			else gate.reject('terminal reason');
			const error = await rejected(pending);
			const context = fallback ? `async descriptor fallback ${sequence ? 'error' : 'reject'}()` : `async descriptor ${sequence ? 'error' : 'reject'}()`;
			assert_descriptor_diagnostic(error, context, bad, job, '.deep.bad');
		});
	}

	test('keeps sequential descriptor unwind paths independent', async () => {
		const gates = [Promise.withResolvers(), Promise.withResolvers()];
		const invalid = [invalid_graph_value('first'), invalid_graph_value('second')];
		const reports = [];
		class Job { constructor(index) { this.index = index; } }
		const jobs = [new Job(0), new Job(1)];
		const root = { jobs };
		const result = await unevalStream(root, (value, js) => value instanceof Job && ({
			type: 'async-value', source: gates[value.index].promise,
			construct: () => js`({})`,
			resolve: () => js`${invalid[value.index].value}`,
			reject: () => js``
		}), { onerror: (error) => reports.push(error) });
		gates[0].resolve(1);
		await result.tail.next();
		gates[1].resolve(2);
		await result.tail.next();
		expect(reports.length).toBe(2);
		assert_descriptor_diagnostic(reports[0], 'async descriptor resolve()', invalid[0].bad, root, '.deep.first');
		assert_descriptor_diagnostic(reports[1], 'async descriptor resolve()', invalid[1].bad, root, '.deep.second');
	});

	for (const reason of [null, undefined]) {
		test(`preserves an arbitrary thrown ${String(reason)} cause without graph fields`, async () => {
			const throwing = {};
			Object.defineProperty(throwing, 'value', { enumerable: true, get() { throw reason; } });
			const ready = Promise.withResolvers();
			const reports = [];
			const job = {};
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: 'async-value', source: ready.promise,
				construct: () => js`({})`,
				resolve: () => js`${throwing}`,
				reject: () => js``
			}), { onerror: (error) => reports.push(error) });
			ready.resolve(1);
			await result.tail.next();
			expect(reports.length).toBe(1);
			expect(Object.hasOwn(reports[0], 'cause')).toBeTruthy();
			expect(reports[0].cause).toBe(reason);
			expect(reports[0].cause instanceof DevalueError).toBeFalsy();
		});
	}

	test('preserves hostile thrown values without inspecting them', async () => {
		const throwing_message = new Error('hidden');
		Object.defineProperty(throwing_message, 'message', { get() { throw new Error('message inspected'); } });
		const hostile_conversion = new Error('hidden');
		Object.defineProperty(hostile_conversion, 'message', {
			value: { [Symbol.toPrimitive]() { throw new Error('message converted'); } }
		});
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		const hostile_cause = {};
		Object.defineProperty(hostile_cause, 'cause', { get() { throw new Error('cause inspected'); } });
		const cyclic_cause = {};
		cyclic_cause.cause = cyclic_cause;
		const reasons = [throwing_message, hostile_conversion, revoked.proxy, hostile_cause, cyclic_cause];

		for (let i = 0; i < reasons.length; i++) {
			const reason = reasons[i];
			const throwing = {};
			Object.defineProperty(throwing, 'value', { enumerable: true, get() { throw reason; } });
			const ready = Promise.withResolvers();
			const reports = [];
			const job = {};
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: 'async-value', source: ready.promise,
				construct: () => js`({})`,
				resolve: () => js`${throwing}`,
				reject: () => js``
			}), { id: `hostile-descriptor-cause-${i}`, onerror: (error) => reports.push(error) });
			ready.resolve(1);
			await result.tail.next();
			expect(reports.length).toBe(1);
			expect(reports[0].message).toMatch(/async descriptor resolve\(\), template hole 1: received an object/);
			expect(Object.hasOwn(reports[0], 'cause')).toBeTruthy();
			expect(reports[0].cause).toBe(reason);
		}
	});

	for (const frozen of [false, true]) {
		test(`does not mutate a ${frozen ? 'frozen' : 'writable'} external DevalueError`, async () => {
			const external_value = {};
			const external_root = {};
			const external = new DevalueError('external failure', ['.external'], external_value, external_root);
			if (frozen) Object.freeze(external);
			const throwing = {};
			Object.defineProperty(throwing, 'prop', { enumerable: true, get() { throw external; } });
			const ready = Promise.withResolvers();
			const reports = [];
			const job = {};
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: 'async-value', source: ready.promise,
				construct: () => js`({})`, resolve: () => js`${throwing}`, reject: () => js``
			}), { id: `external-devalue-error-${frozen}`, onerror: (error) => reports.push(error) });
			ready.resolve(1);
			await result.tail.next();
			expect(reports.length).toBe(1);
			expect(reports[0].cause).toBe(external);
			expect(external.path).toBe('.external');
			expect(external.value).toBe(external_value);
			expect(external.root).toBe(external_root);
		});
	}

	test('does not reuse reported Symbol ownership while lowering descriptor holes', async () => {
		for (const mode of ['writable', 'frozen', 'hostile message']) {
			const gates = [Promise.withResolvers(), Promise.withResolvers()];
			const jobs = [{ index: 0 }, { index: 1 }];
			const reports = [];
			let original;
			let message_reads = 0;
			const throwing = {};
			Object.defineProperty(throwing, 'prop', { enumerable: true, get() { throw original; } });
			const result = await unevalStream(jobs, (value, js) => jobs.includes(value) && ({
				type: 'async-value', source: gates[value.index].promise,
				construct: () => js`({})`,
				resolve: () => value.index === 1 ? js`${throwing}` : js``,
				reject: () => js``
			}), { id: `expired-descriptor-symbol-${mode}`, onerror: (error) => reports.push(error) });
			const target = client();
			target.head(result.head);

			const symbol = Symbol(mode);
			gates[0].resolve(symbol);
			target.block((await result.tail.next()).value);
			expect(reports.length).toBe(1);
			original = reports[0];
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

			gates[1].resolve(1);
			target.block((await result.tail.next()).value);
			expect(reports.length).toBe(2);
			expect(reports[1]).toBeInstanceOf(TypeError);
			expect(reports[1].message).toMatch(/async descriptor resolve\(\), template hole 1: received an object/);
			expect(reports[1].cause).toBe(original);
			expect(original.path).toBe(fields.path);
			expect(original.value).toBe(fields.value);
			expect(original.root).toBe(fields.root);
			expect(message_reads).toBe(0);
		}
	});

	test('keeps nested Symbol ownership active until descriptor rollback adds its path', async () => {
		const symbol = Symbol('nested');
		const nested = { deep: { bad: symbol } };
		const job = {};
		const error = await rejected(unevalStream(job, (value, js) => value === job && ({
			type: 'async-value', source: new Promise(() => {}),
			construct: () => js`${nested}`,
			resolve: () => js``, reject: () => js``
		})));
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toMatch(/async descriptor construct\(\), template hole 1/);
		expect(error.cause).toBeInstanceOf(DevalueError);
		expect(error.cause.value).toBe(symbol);
		expect(error.cause.root).toBe(job);
		expect(error.cause.path).toBe('.deep.bad');
	});

	for (const mode of ['construct', 'capture']) {
		test(`preserves an external cause during initial descriptor ${mode}`, async () => {
			const reason = new Error(`external ${mode} failure`);
			Object.defineProperty(reason, 'message', { get() { throw new Error('message inspected'); } });
			const throwing = {};
			Object.defineProperty(throwing, 'prop', { enumerable: true, get() { throw reason; } });
			const job = {};
			const error = await rejected(unevalStream(job, (value, js) => value === job && ({
				type: 'async-value', source: new Promise(() => {}),
				construct: (capture) => mode === 'construct'
					? js`({value:${throwing}})`
					: js`({control:${capture(js`[${throwing}]`)}})`,
				resolve: () => js``, reject: () => js``
			})));
			expect(error.message).toMatch(new RegExp(`async descriptor ${mode}\\(\\), template hole 1: received an object`));
			expect(error.cause).toBe(reason);
		});
	}

	test('preserves immediate causes through nested descriptor wrappers', async () => {
		class Job { constructor(name) { this.name = name; } }
		const outer = new Job('outer');
		const inner = new Job('inner');
		const reason = {};
		Object.defineProperty(reason, 'cause', { get() { throw new Error('cause inspected'); } });
		const throwing = {};
		Object.defineProperty(throwing, 'prop', { enumerable: true, get() { throw reason; } });
		const error = await rejected(unevalStream(outer, (value, js) => value instanceof Job && ({
			type: 'async-value', source: new Promise(() => {}),
			construct: () => value === outer ? js`({inner:${inner}})` : js`({value:${throwing}})`,
			resolve: () => js``, reject: () => js``
		})));
		expect(error.message).toMatch(/async descriptor construct\(\), template hole 1/);
		expect(error.cause).toBeInstanceOf(TypeError);
		expect(error.cause.message).toMatch(/async descriptor construct\(\), template hole 1/);
		expect(error.cause.cause).toBe(reason);
	});

	for (const phase of ['reject', 'error', 'fallback reject', 'fallback error']) {
		test(`preserves an external cause in fatal ${phase} interpolation`, async () => {
			const reason = new Error('private terminal failure');
			Object.defineProperty(reason, 'message', { get() { throw new Error('message inspected'); } });
			const throwing = {};
			Object.defineProperty(throwing, 'prop', { enumerable: true, get() { throw reason; } });
			const ready = Promise.withResolvers();
			const job = {};
			const fallback = phase.startsWith('fallback');
			const sequence = phase.endsWith('error');
			const source = sequence ? {
				[Symbol.asyncIterator]() { return this; },
				next() { return ready.promise; }
			} : ready.promise;
			const result = await unevalStream(job, (value, js) => value === job && ({
				type: sequence ? 'async-sequence' : 'async-value', source,
				construct: () => js`({})`,
				resolve: () => fallback ? js`${() => {}}` : js``,
				next: () => fallback ? js`${() => {}}` : js``,
				complete: () => js``,
				reject: () => js`${throwing}`,
				error: () => js`${throwing}`
			}));
			const pending = result.tail.next();
			if (fallback) ready.resolve(sequence ? { done: false, value: 1 } : 1);
			else ready.reject('terminal reason');
			const error = await rejected(pending);
			expect(error.message).toMatch(new RegExp(`async descriptor ${phase}\\(\\), template hole 1`));
			expect(error.cause).toBe(reason);
		});
	}

	test('keeps Symbol interpolation clear and does not inspect hostile description hooks', async () => {
		const gates = [Promise.withResolvers(), Promise.withResolvers()];
		const reports = [];
		let inspections = 0;
		const hostile = function hostile() {};
		for (const key of ['constructor', 'toString']) {
			Object.defineProperty(hostile, key, { get() { inspections++; throw new Error('inspected'); } });
		}
		Object.defineProperty(hostile, Symbol.toStringTag, { get() { inspections++; throw new Error('inspected'); } });
		const jobs = [{ index: 0 }, { index: 1 }];
		const result = await unevalStream(jobs, (value, js) => jobs.includes(value) && ({
			type: 'async-value', source: gates[value.index].promise,
			construct: () => js`({})`,
			resolve: () => value.index === 0 ? js`${Symbol('private')}` : js`${hostile}`,
			reject: () => js``
		}), { onerror: (error) => reports.push(error) });
		gates[0].resolve(1);
		await result.tail.next();
		gates[1].resolve(2);
		await result.tail.next();
		expect(inspections).toBe(0);
		expect(reports[0].message).toMatch(/received a Symbol.*Symbol values cannot be serialized/);
		expect(Object.hasOwn(reports[0], 'cause')).toBeFalsy();
		expect(reports[1].message).toMatch(/received a function/);
		expect(reports[1].cause).toBeInstanceOf(DevalueError);
		expect(reports[1].cause.value).toBe(hostile);
	});

	test('starts nested operation descriptors only after committed output', async () => {
		class Job { constructor(ready) { this.ready = ready; } }
		const outer = Promise.withResolvers();
		const nested = Promise.withResolvers();
		const root_job = new Job(outer);
		const nested_job = new Job(nested);
		let then_reads = 0;
		const replacer = (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: { get then() { then_reads++; return value.ready.promise.then.bind(value.ready.promise); } },
			construct: (capture) => js`({control:${capture(js`[]`)},value:null})`,
			resolve: ({ target }, payload) => js`${target}.value=${payload}`,
			reject: () => js``
		});
		const result = await unevalStream(root_job, replacer, { id: 'nested-operation-source' });
		const target = client();
		const root = target.head(result.head);
		expect(then_reads).toBe(1);
		outer.resolve(nested_job);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(then_reads).toBe(1);
		const block = await result.tail.next();
		target.block(block.value);
		expect(then_reads).toBe(2);
		nested.resolve({ done: true });
		for await (const block of result.tail) target.block(block);
		expect(root.value.value.done).toBe(true);
	});

	test('rolls back a nested descriptor before an invalid operation hole', async () => {
		class Job {}
		const ready = Promise.withResolvers();
		const nested = new Job();
		let then_reads = 0;
		let cancels = 0;
		const root_job = {};
		const reports = [];
		const result = await unevalStream(root_job, (value, js) => {
			if (value === nested) return {
				type: 'async-value',
				source: { get then() { then_reads++; return () => {}; } },
				construct: () => js`({})`, resolve: () => js``, reject: () => js``,
				cancel() { cancels++; }
			};
			if (value === root_job) return {
				type: 'async-value', source: ready.promise,
				construct: () => js`({error:null})`,
				resolve: () => js`${nested};${() => {}}`,
				reject: ({ target }, error) => js`${target}.error=${error}`
			};
		}, { id: 'operation-transaction', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		ready.resolve(1);
		target.block((await result.tail.next()).value);
		expect(reports.length).toBe(1);
		expect(root.error.message).toMatch(/failed to serialize asynchronous value/);
		expect(then_reads).toBe(0);
		expect(cancels).toBe(0);
	});

	test('rejects atomic descriptor cycles and permits container-mediated cycles', async () => {
		class Job { constructor() { this.child = this; this.ready = new Promise(() => {}); } }
		const atomic = new Job();
		const error = await rejected(unevalStream(atomic, (value, js) => value instanceof Job && ({
			type: 'async-value', source: value.ready,
			construct: () => js`({child:${value.child}})`, resolve: () => js``, reject: () => js``
		})));
		expect(error.message).toMatch(/atomic custom cycle/);

		const mixed = new Job();
		const holder = { child: mixed };
		mixed.child = holder;
		const result = await unevalStream(mixed, (value, js) => value instanceof Job && ({
			type: 'async-value', source: value.ready,
			construct: () => js`({child:${value.child}})`, resolve: () => js``, reject: () => js``
		}));
		const root = client().head(result.head);
		expect(root.child.child).toBe(root);
		await result.tail.return();
	});

});
