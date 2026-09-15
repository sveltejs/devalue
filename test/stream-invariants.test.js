import vm from 'node:vm';
import { describe, test, expect } from 'vitest';
import { uneval, unevalStream } from '../index.js';

describe('unevalStream cross-feature invariants', () => {

	function deferred() {
		let resolve;
		let reject;
		const promise = new Promise((fulfil, fail) => {
			resolve = fulfil;
			reject = fail;
		});
		return { promise, resolve, reject };
	}

	function client(extra = {}) {
		const context = vm.createContext({ ...extra });
		context.globalThis = context;
		return {
			context,
			head: (source) => vm.runInContext(`(${source})`, context),
			block: (source) => vm.runInContext(source, context),
			combined: (head, blocks) => vm.runInContext(
				`(function(){const root=(${head});${blocks.join('')};return root})()`,
				context
			)
		};
	}

	const turn = () => new Promise((resolve) => setImmediate(resolve));

	async function with_watchdog(label, operation) {
		let timer;
		try {
			return await Promise.race([
				operation,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`watchdog expired: ${label}`)), 5000);
				})
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function rejected(operation) {
		try {
			await operation;
		} catch (error) {
			return error;
		}
		expect.unreachable('expected rejection');
	}

	class MatrixWrapper {
		constructor(kind, value) {
			this.kind = kind;
			this.value = value;
		}
	}

	function seeded_random(seed) {
		let state = seed >>> 0;
		return () => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x1_0000_0000;
		};
	}

	function shuffle(values, random) {
		for (let i = values.length - 1; i > 0; i -= 1) {
			const j = Math.floor(random() * (i + 1));
			[values[i], values[j]] = [values[j], values[i]];
		}
		return values;
	}

	function build_matrix_case(seed, promises) {
		const random = seeded_random(seed);
		const nodes = Array.from({ length: 8 }, (_, index) => ({
			index,
			label: `node-${seed}-${index}`,
			next: null
		}));
		for (let i = 0; i < nodes.length; i += 1) {
			nodes[i].next = nodes[(i + 1 + Math.floor(random() * 3)) % nodes.length];
		}

		const shared = nodes[Math.floor(random() * nodes.length)];
		const distinct = { index: shared.index, label: shared.label, next: shared.next };
		const null_object = Object.assign(Object.create(null), {
			kind: 'null-object',
			shared,
			distinct
		});
		const sparse = Array(7);
		sparse[1] = shared;
		sparse[4] = null_object;
		const buffer = new ArrayBuffer(12);
		const bytes = new Uint8Array(buffer);
		for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 17 + i * 29) & 255;
		const view = new Uint16Array(buffer, 2, 4);
		const wrapped = new MatrixWrapper(`wrapper-${seed}`, shared);
		const constructor_read = new MatrixWrapper(`constructor-${seed}`, { items: sparse });
		const map = new Map(shuffle([
			[shared, view],
			[null_object, sparse],
			[distinct, buffer]
		], random));
		const set = new Set(shuffle([view, shared, null_object, distinct], random));

		const outcome_a = {
			kind: 'outcome-a',
			shared,
			wrapped,
			map: new Map([[shared, nodes[(seed + 3) % nodes.length]]])
		};
		const outcome_b = Object.assign(Object.create(null), {
			kind: 'outcome-b',
			items: [outcome_a, shared, view],
			set: new Set([distinct, outcome_a, buffer])
		});
		const outcomes = [outcome_a, outcome_b, outcome_a];
		const entries = shuffle([
			['seed', seed],
			['numeric', { '0': '0', '12': '12', '001': '001' }],
			['nodes', nodes],
			['shared', shared],
			['distinct', distinct],
			['null_object', null_object],
			['sparse', sparse],
			['map', map],
			['set', set],
			['buffer', buffer],
			['view', view],
			['wrapped', wrapped],
			['constructor_read', constructor_read],
			['promises', promises]
		], random);
		return { root: Object.fromEntries(entries), outcomes, wrappers: [wrapped, constructor_read], constructor_read };
	}

	function compare_topology(server, revived, label, server_to_client = new Map(), client_to_server = new WeakMap()) {
		if (server === null || typeof server !== 'object') {
			expect(Object.is(revived, server), `${label}: primitive values differ`).toBeTruthy();
			return;
		}

		if (server_to_client.has(server)) {
			expect(revived, `${label}: repeated identity differs`).toBe(server_to_client.get(server));
			return;
		}
		expect(revived !== null && (typeof revived === 'object' || typeof revived === 'function'), `${label}: expected an object`).toBeTruthy();
		expect(!client_to_server.has(revived), `${label}: distinct server nodes collapsed`).toBeTruthy();
		server_to_client.set(server, revived);
		client_to_server.set(revived, server);

		if (server instanceof Promise) {
			expect(typeof revived?.then, `${label}: expected a reconstructed Promise`).toBe('function');
			return;
		}
		if (server instanceof MatrixWrapper) {
			expect(Object.keys(revived), `${label}: custom wrapper fields differ`).toEqual(['kind', 'value']);
			compare_topology(server.kind, revived.kind, `${label}.kind`, server_to_client, client_to_server);
			compare_topology(server.value, revived.value, `${label}.value`, server_to_client, client_to_server);
			return;
		}
		if (server instanceof ArrayBuffer) {
			expect(Object.prototype.toString.call(revived), `${label}: expected ArrayBuffer`).toBe('[object ArrayBuffer]');
			expect(Array.from(new Uint8Array(revived)), `${label}: buffer bytes differ`).toEqual(Array.from(new Uint8Array(server)));
			return;
		}
		if (ArrayBuffer.isView(server)) {
			expect(Object.prototype.toString.call(revived), `${label}: view kind differs`).toBe(Object.prototype.toString.call(server));
			expect(revived.byteOffset, `${label}: view offset differs`).toBe(server.byteOffset);
			expect(revived.byteLength, `${label}: view length differs`).toBe(server.byteLength);
			compare_topology(server.buffer, revived.buffer, `${label}.buffer`, server_to_client, client_to_server);
			expect(Array.from(new Uint8Array(revived.buffer, revived.byteOffset, revived.byteLength)), `${label}: view bytes differ`).toEqual(Array.from(new Uint8Array(server.buffer, server.byteOffset, server.byteLength)));
			return;
		}
		if (server instanceof Map) {
			const server_entries = Array.from(server);
			const revived_entries = Array.from(revived);
			expect(revived_entries.length, `${label}: Map size differs`).toBe(server_entries.length);
			for (let i = 0; i < server_entries.length; i += 1) {
				compare_topology(server_entries[i][0], revived_entries[i][0], `${label}.key[${i}]`, server_to_client, client_to_server);
				compare_topology(server_entries[i][1], revived_entries[i][1], `${label}.value[${i}]`, server_to_client, client_to_server);
			}
			return;
		}
		if (server instanceof Set) {
			const server_values = Array.from(server);
			const revived_values = Array.from(revived);
			expect(revived_values.length, `${label}: Set size differs`).toBe(server_values.length);
			for (let i = 0; i < server_values.length; i += 1) {
				compare_topology(server_values[i], revived_values[i], `${label}.member[${i}]`, server_to_client, client_to_server);
			}
			return;
		}

		expect(Array.isArray(revived), `${label}: Array kind differs`).toBe(Array.isArray(server));
		expect(Object.getPrototypeOf(revived) === null, `${label}: prototype differs`).toBe(Object.getPrototypeOf(server) === null);
		const server_keys = Object.keys(server);
		expect(Object.keys(revived), `${label}: property order differs`).toEqual(server_keys);
		for (const key of server_keys) {
			compare_topology(server[key], revived[key], `${label}[${JSON.stringify(key)}]`, server_to_client, client_to_server);
		}
	}

	function matrix_replacer(calls) {
		return (value, js) => {
			if (!(value instanceof MatrixWrapper)) return;
			calls.set(value, (calls.get(value) ?? 0) + 1);
			if (value.kind.startsWith('constructor-')) {
				return js`Object.defineProperty({kind:${value.kind},value:${value.value}},"observed",{value:${value.value}.items[4].kind})`;
			}
			return js`({kind:${value.kind},value:${value.value}})`;
		};
	}

	async function run_matrix_case(seed, schedule) {
		const gates = schedule === 'all-ready' ? null : [deferred(), deferred(), deferred()];
		const placeholders = gates?.map((gate) => gate.promise) ?? [Promise.resolve(), Promise.resolve(), Promise.resolve()];
		const graph = build_matrix_case(seed, placeholders);
		if (!gates) {
			for (let i = 0; i < placeholders.length; i += 1) placeholders[i] = Promise.resolve(graph.outcomes[i]);
			graph.root.promises = placeholders;
		}
		const calls = new Map();
		const result = await unevalStream(graph.root, matrix_replacer(calls), { id: `matrix-${seed}-${schedule}` });
		const target = client();
		const root = target.head(result.head);

		try {
			if (gates && schedule === 'staggered') {
				for (let i = 0; i < gates.length; i += 1) {
					gates[i].resolve(graph.outcomes[i]);
					const next = await result.tail.next();
					expect(next.done, `seed ${seed}, ${schedule}: event ${i} was not delivered`).toBe(false);
					target.block(next.value);
				}
			} else if (gates) {
				for (let i = 0; i < gates.length; i += 1) gates[i].resolve(graph.outcomes[i]);
				if (schedule === 'idle-consumer') await turn();
			}
			for await (const block of result.tail) target.block(block);

			const server_to_client = new Map();
			const client_to_server = new WeakMap();
			compare_topology(graph.root, root, `seed ${seed}, ${schedule}`, server_to_client, client_to_server);
			for (let i = 0; i < graph.outcomes.length; i += 1) {
				const revived = await root.promises[i];
				compare_topology(
					graph.outcomes[i],
					revived,
					`seed ${seed}, ${schedule}, outcome ${i}`,
					server_to_client,
					client_to_server
				);
			}
			for (const wrapper of graph.wrappers) {
				expect(calls.get(wrapper), `seed ${seed}, ${schedule}: replacer call count`).toBe(1);
			}
			expect(server_to_client.get(graph.constructor_read).observed, `seed ${seed}, ${schedule}: sparse/null constructor read`).toBe('null-object');
		} finally {
			await result.tail.return();
		}
	}

	test('preserves bounded fixed-seed graph topology across observation schedules', async () => {
		const seeds = [1, 7, 19, 31, 43, 61];
		const schedules = ['all-ready', 'simultaneous-tail', 'staggered', 'idle-consumer'];
		for (const seed of seeds) {
			for (const schedule of schedules) {
				await with_watchdog(`seed ${seed}, ${schedule}`, run_matrix_case(seed, schedule));
			}
		}
	});

	test('preserves ordinary custom-mode Object Map and Set cycle order in bounded release cases', () => {
		class Wrapped {
			constructor(value) { this.value = value; }
		}
		const replacer = (value, js) => value instanceof Wrapped && js`({value:${value.value}})`;
		for (const kind of ['Object', 'Map', 'Set']) {
			for (const position of [0, 1, 2]) {
				let value;
				if (kind === 'Object') {
					value = {};
					for (let i = 0; i < 3; i++) value[`key${i}`] = i === position ? value : i;
				} else if (kind === 'Map') {
					value = new Map();
					for (let i = 0; i < 3; i++) value.set(`key${i}`, i === position ? value : i);
				} else {
					value = new Set();
					for (let i = 0; i < 3; i++) value.add(i === position ? value : i);
				}
				const source = uneval(new Wrapped(value), replacer);
				const revived = Function(`return (${source})`)().value;
				const label = `${kind} cycle position ${position}`;
				if (kind === 'Map') {
					expect(Array.from(revived.keys()), `${label}: order`).toEqual(['key0', 'key1', 'key2']);
					expect(revived.get(`key${position}`), `${label}: cycle`).toBe(revived);
				} else if (kind === 'Set') {
					expect(Array.from(revived, (entry) => entry === revived ? 'cycle' : entry), `${label}: order`).toEqual(Array.from({ length: 3 }, (_, i) => i === position ? 'cycle' : i));
				} else {
					expect(Object.keys(revived), `${label}: order`).toEqual(['key0', 'key1', 'key2']);
					expect(revived[`key${position}`], `${label}: cycle`).toBe(revived);
				}
			}
		}
	});

	class ConstructionWrapper {
		constructor(kind, value, again = undefined) {
			this.kind = kind;
			this.value = value;
			this.again = again;
		}
	}

	function build_construction_graph() {
		const child = { label: 'ready' };
		const null_child = Object.assign(Object.create(null), { x: 42 });
		const sparse_child = Array(3);
		sparse_child[1] = 42;
		const nested_null = Object.assign(Object.create(null), { x: 42 });
		const nested_sparse = Array(3);
		nested_sparse[1] = nested_null;
		const repeated = new ConstructionWrapper('read', child);
		const null_read = new ConstructionWrapper('null', null_child);
		const sparse_read = new ConstructionWrapper('sparse', sparse_child);
		const nested_read = new ConstructionWrapper('nested-containers', { items: nested_sparse });
		const single_null = new ConstructionWrapper('null-single', Object.assign(Object.create(null), { x: 42 }));
		const inner = new ConstructionWrapper('inner', { label: 'inner-ready' });
		const nested = new ConstructionWrapper('nested', inner);
		const hidden = new ConstructionWrapper('hidden', { label: 'hidden-ready' });
		const inline = new ConstructionWrapper('inline', { hidden });
		const multiple = new ConstructionWrapper('multiple', child, child);
		const buffer = new ArrayBuffer(12);
		const view = new Uint8Array(buffer, 3, 5);
		const typed = new ConstructionWrapper('view', { view, buffer });
		const holder = { label: 'holder', custom: null };
		const cycle = new ConstructionWrapper('cycle', holder);
		holder.custom = cycle;
		return {
			root: {
				child,
				null_child,
				sparse_child,
				nested_sparse,
				repeated: [repeated, repeated],
				null_read: [null_read, null_read],
				sparse_read: [sparse_read, sparse_read],
				nested_read: [nested_read, nested_read],
				single_null,
				inner,
				nested,
				inline,
				multiple,
				buffer,
				view,
				typed,
				holder,
				cycle
			},
			wrappers: [repeated, null_read, sparse_read, nested_read, single_null, inner, nested, hidden, inline, multiple, typed, cycle]
		};
	}

	function construction_replacer(calls) {
		return (value, js) => {
			if (!(value instanceof ConstructionWrapper)) return;
			calls.set(value, (calls.get(value) ?? 0) + 1);
			return js`new Constructed(${value.kind},${value.value},${value.again})`;
		};
	}

	function construction_client() {
		const calls = new Map();
		class Constructed {
			constructor(kind, value, again) {
				calls.set(kind, (calls.get(kind) ?? 0) + 1);
				this.kind = kind;
				this.value = value;
				this.again = again;
				if (kind === 'read' || kind === 'inner' || kind === 'hidden') this.observed = value.label;
				if (kind === 'nested') this.observed = value.kind;
				if (kind === 'inline') this.observed = value.hidden.kind;
				if (kind === 'multiple') this.observed = value === again;
				if (kind === 'view') this.observed = value.view.buffer === value.buffer;
				if (kind === 'null' || kind === 'null-single') this.observed = value.x;
				if (kind === 'sparse') this.observed = value[1];
				if (kind === 'nested-containers') this.observed = value.items[1].x;
			}
		}
		return { target: client({ Constructed }), calls };
	}

	function verify_construction_graph(root, calls, label) {
		expect(root.repeated[0], `${label}: repeated custom identity`).toBe(root.repeated[1]);
		expect(root.repeated[0].value, `${label}: acyclic child identity`).toBe(root.child);
		expect(root.repeated[0].observed, `${label}: ordinary child unavailable during construction`).toBe('ready');
		expect(root.null_read[0], `${label}: repeated null reader identity`).toBe(root.null_read[1]);
		expect(root.null_read[0].value, `${label}: null child identity`).toBe(root.null_child);
		expect(root.null_read[0].observed, `${label}: null child unavailable during construction`).toBe(42);
		expect(root.sparse_read[0], `${label}: repeated sparse reader identity`).toBe(root.sparse_read[1]);
		expect(root.sparse_read[0].value, `${label}: sparse child identity`).toBe(root.sparse_child);
		expect(root.sparse_read[0].observed, `${label}: sparse child unavailable during construction`).toBe(42);
		expect(root.nested_read[0], `${label}: repeated nested reader identity`).toBe(root.nested_read[1]);
		expect(root.nested_read[0].value.items, `${label}: nested sparse child identity`).toBe(root.nested_sparse);
		expect(root.nested_read[0].observed, `${label}: nested container child unavailable during construction`).toBe(42);
		expect(root.single_null.observed, `${label}: single-use null child unavailable during construction`).toBe(42);
		expect(root.nested.value, `${label}: nested custom identity`).toBe(root.inner);
		expect(root.nested.observed, `${label}: nested constructor order`).toBe('inner');
		expect(root.inline.observed, `${label}: inline-container dependency order`).toBe('hidden');
		expect(root.multiple.value, `${label}: repeated source-hole identity`).toBe(root.multiple.again);
		expect(root.multiple.observed, `${label}: repeated source-hole constructor input`).toBe(true);
		expect(root.typed.value.view, `${label}: typed view identity`).toBe(root.view);
		expect(root.typed.value.buffer, `${label}: buffer identity`).toBe(root.buffer);
		expect(root.view.buffer, `${label}: view/buffer sharing`).toBe(root.buffer);
		expect(root.typed.observed, `${label}: view buffer unavailable during construction`).toBe(true);
		expect(root.cycle, `${label}: mutable-container back-edge`).toBe(root.holder.custom);
		expect(root.cycle.value, `${label}: mutable-container child`).toBe(root.holder);
		for (const kind of ['read', 'null', 'sparse', 'nested-containers', 'null-single', 'inner', 'nested', 'hidden', 'inline', 'multiple', 'view', 'cycle']) {
			expect(calls.get(kind), `${label}: ${kind} client constructor call count`).toBe(1);
		}
	}

	test('retains synchronous custom construction parity in head, folded, and outcome regions', async () => {
		for (const region of ['head', 'folded', 'outcome']) {
			const graph = build_construction_graph();
			const replacer_calls = new Map();
			const gate = deferred();
			const value = region === 'head' ? graph.root : region === 'folded' ? Promise.resolve(graph.root) : gate.promise;
			const result = await unevalStream(value, construction_replacer(replacer_calls), { id: `construction-${region}` });
			const { target, calls } = construction_client();
			let root = target.head(result.head);
			try {
				if (region === 'outcome') gate.resolve(graph.root);
				for await (const block of result.tail) target.block(block);
				if (region !== 'head') root = await root;
				verify_construction_graph(root, calls, region);
				for (const wrapper of graph.wrappers) {
					expect(replacer_calls.get(wrapper), `${region}: represented replacer call count`).toBe(1);
				}
			} finally {
				await result.tail.return();
			}
		}
	});

	test('rejects self and mutual atomic-only custom cycles in initial and outcome graphs', async () => {
		const replacer = (value, js) => value instanceof ConstructionWrapper && js`({value:${value.value}})`;
		const self = new ConstructionWrapper('self', null);
		self.value = self;
		const self_error = await rejected(unevalStream(self, replacer));
		expect(self_error.message).toMatch(/atomic custom cycle/);

		const left = new ConstructionWrapper('left', null);
		const right = new ConstructionWrapper('right', left);
		left.value = right;
		const mutual_error = await rejected(unevalStream(left, replacer));
		expect(mutual_error.message).toMatch(/atomic custom cycle/);

		const gate = deferred();
		const reports = [];
		const result = await unevalStream(gate.promise, replacer, { id: 'outcome-atomic-cycle', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		const client_error = rejected(root);
		gate.resolve(self);
		for await (const block of result.tail) target.block(block);
		expect((await client_error).message).toMatch(/failed to serialize asynchronous value/);
		expect(reports.length).toBe(1);
		expect(reports[0].message).toMatch(/atomic custom cycle/);
	});

	test('keeps descriptor provenance private and operation payloads lazy after completion', async () => {
		class Job {
			constructor() {
				this.ready = deferred();
			}
		}
		class Payload {
			constructor(value) {
				this.value = value;
			}
		}
		const job = new Job();
		const payload = new Payload({ type: 'reference', value: 7 });
		let job_calls = 0;
		let payload_calls = 0;
		const result = await unevalStream(job, (value, js) => {
			if (value instanceof Payload) {
				payload_calls += 1;
				return js`(globalThis.payload_constructions++,{value:${value.value}})`;
			}
			if (!(value instanceof Job)) return;
			job_calls += 1;
			return {
				type: 'async-value',
				immediate: true,
				source: value.ready.promise,
				construct: () => js`({get:null,same:false})`,
				resolve: ({ target }, outcome) => js`${target}.get=()=>${outcome};${target}.same=${outcome}===${outcome}`,
				reject: () => js``
			};
		}, { id: 'private-immediate' });
		const target = client({ payload_constructions: 0 });
		const root = target.head(result.head);
		job.ready.resolve(payload);
		for await (const block of result.tail) target.block(block);
		expect(job_calls).toBe(1);
		expect(payload_calls).toBe(1);
		expect(target.context.payload_constructions).toBe(1);
		expect(root.same).toBe(true);
		expect(root.get().value.type).toBe('reference');
		expect(root.get().value.value).toBe(7);
	});

	test('keeps one sequence pull outstanding while repeated roots retain identity', async () => {
		const repeated = { value: 'same' };
		const controls = [];
		let outstanding = 0;
		let maximum = 0;
		let closed = false;
		const source = {
			[Symbol.asyncIterator]() {
				return this;
			},
			next() {
				if (closed) return { done: true, value: undefined };
				const gate = deferred();
				outstanding += 1;
				maximum = Math.max(maximum, outstanding);
				controls.push((result) => {
					outstanding -= 1;
					gate.resolve(result);
				});
				return gate.promise;
			},
			return() {
				closed = true;
				while (controls.length) controls.shift()({ done: true, value: undefined });
				return { done: true, value: undefined };
			}
		};
		const result = await unevalStream(source, undefined, { id: 'invariant-repeated-sequence' });
		const target = client();
		const root = target.head(result.head);
		const revived = [];
		try {
			for (let i = 0; i < 4; i += 1) {
				const read = root.next();
				expect(outstanding, `item ${i}: expected one outstanding server pull`).toBe(1);
				controls.shift()({ done: false, value: repeated });
				const block = await result.tail.next();
				expect(block.done, `item ${i}: expected a tail block`).toBe(false);
				target.block(block.value);
				revived.push((await read).value);
			}
			const complete = root.next();
			expect(outstanding, 'completion: expected one outstanding server pull').toBe(1);
			controls.shift()({ done: true, value: 'done' });
			const block = await result.tail.next();
			expect(block.done, 'completion: expected a tail block').toBe(false);
			target.block(block.value);
			const terminal = await complete;
			expect(terminal.done).toBe(true);
			expect(terminal.value).toBe('done');
			expect(await result.tail.next()).toEqual({ done: true, value: undefined });
			expect(maximum).toBe(1);
			for (const value of revived) expect(value).toBe(revived[0]);
		} finally {
			await result.tail.return();
		}
	});

	function utf8_transport(source) {
		const bytes = new TextEncoder().encode(source);
		const decoder = new TextDecoder();
		let reconstructed = '';
		for (const byte of bytes) reconstructed += decoder.decode(Uint8Array.of(byte), { stream: true });
		reconstructed += decoder.decode();
		return reconstructed;
	}

	async function verify_transport_root(root, shared, reason, label) {
		expect(Object.keys(root.numeric)).toEqual(['0', '12', '001']);
		expect(root.numeric[0]).toBe('0');
		expect(root.lone).toBe('\ud800');
		expect(root.pair).toBe('😀');
		expect(root.closing).toBe('</script><script>data</script>');
		expect(root.protocol.type).toBe('reference');
		expect(root.protocol.value).toBe('001');
		const outcome = await root.resolved;
		expect(outcome.shared, `${label}: outcome/head identity`).toBe(root.shared);
		expect(outcome.again, `${label}: outcome repeated identity`).toBe(outcome.shared);
		expect(outcome.shared.label).toBe(shared.label);
		const error = await rejected(root.rejected);
		expect(error, `${label}: late rejection reason`).toBe(reason);
	}

	test('survives UTF-8 byte boundaries and separate or concatenated VM evaluation', async () => {
		const resolved = deferred();
		const failed = deferred();
		const shared = { label: 'shared-😀' };
		const reason = 'late </script> rejection 😀 \udfff';
		const id = 'transport-001-😀-</script>-\ud800';
		const server_root = {
			numeric: { '0': '0', '12': '12', '001': '001' },
			lone: '\ud800',
			pair: '😀',
			closing: '</script><script>data</script>',
			protocol: { type: 'reference', value: '001' },
			shared,
			resolved: resolved.promise,
			rejected: failed.promise
		};
		const result = await unevalStream(server_root, undefined, { id });
		expect(result.id).toBe(id);
		resolved.resolve({ shared, again: shared });
		failed.reject(reason);
		const blocks = [];
		for await (const block of result.tail) blocks.push(block);
		const sources = [result.head, ...blocks];
		for (let i = 0; i < sources.length; i += 1) {
			expect(utf8_transport(sources[i]), `source ${i}: UTF-8 reconstruction differs`).toBe(sources[i]);
		}
		expect(sources.join('')).not.toMatch(/<\/script/gi);

		const separate_target = client();
		const separate_root = separate_target.head(utf8_transport(result.head));
		for (const block of blocks) separate_target.block(utf8_transport(block));
		await verify_transport_root(separate_root, shared, reason, 'separate');

		const combined_target = client();
		const combined_root = combined_target.combined(utf8_transport(result.head), blocks.map(utf8_transport));
		await verify_transport_root(combined_root, shared, reason, 'combined');
	});

});
