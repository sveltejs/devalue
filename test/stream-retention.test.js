import { test } from 'vitest';
import { in_subprocess } from './helpers/subprocess.js';

async function retention({ assert, turn, unevalStream, data: mode }) {
	assert.equal(typeof global.gc, 'function');

	function create_root() {
		const source = Promise.withResolvers();
		const graph = { nodes: Array.from({ length: 1000 }, (_, i) => ({ i })) };
		graph.self = graph;
		if (mode !== 'plain replacer') graph.pending = source.promise;
		const weak = new WeakRef(graph);
		const node_weak = new WeakRef(graph.nodes[500]);
		const controller = new AbortController();
		const result =
			mode === 'sanity'
				? null
				: unevalStream(graph, mode === 'plain replacer' ? () => undefined : undefined, {
						signal: controller.signal
					});
		// Only the live control keeps an explicit input reference. This does not require
		// active streams to use strong caches rather than an otherwise valid WeakMap.
		return {
			source,
			weak,
			node_weak,
			controller,
			result,
			live_graph: mode === 'live' ? graph : null
		};
	}

	async function cancel(fixture) {
		const next = fixture.result.tail.next();
		if (mode.startsWith('return')) {
			assert.deepEqual(await fixture.result.tail.return(), { done: true, value: undefined });
			assert.deepEqual(await next, { done: true, value: undefined });
		} else {
			const reason = new Error('abort stream');
			fixture.controller.abort(reason);
			await assert.rejects(next, (error) => error === reason);
		}
		if (!mode.endsWith('retained')) fixture.result = null;
		fixture.controller = null;
	}

	const fixture = create_root();
	let settled = false;
	fixture.source.promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		}
	);
	if (mode.startsWith('return') || mode.startsWith('abort')) {
		await cancel(fixture);
	} else if (mode === 'complete') {
		fixture.source.resolve(42);
		for await (const block of fixture.result.tail) assert.equal(typeof block, 'string');
	} else if (mode === 'plain replacer') {
		assert.deepEqual(await fixture.result.tail.next(), { done: true, value: undefined });
	}

	// A deref during this loop would pin the target for the current job. Check only
	// after repeated GCs in distinct jobs, including a turn after WeakRef creation.
	for (let i = 0; i < 20; i += 1) {
		await turn();
		global.gc();
	}
	assert.ok(fixture.source.promise instanceof Promise, 'source remains externally held');
	assert.equal(settled, mode === 'complete', 'cancelled sources must remain pending');
	if (mode === 'live') {
		assert.ok(fixture.result.head.length);
		assert.equal(fixture.weak.deref(), fixture.live_graph);
		assert.ok(fixture.node_weak.deref());
	} else {
		if (mode === 'complete' || mode === 'plain replacer' || mode.endsWith('retained')) {
			assert.ok(fixture.result.head.length, 'the finished result remains externally held');
		}
		assert.ok(fixture.weak.deref() === undefined, `${mode}: stream retained the input root`);
		assert.ok(fixture.node_weak.deref() === undefined, `${mode}: stream retained an input node`);
	}
	// Only after proving collection with the source still held and pending, show
	// that cancellation did not cancel the job and late delivery stays detached.
	if (mode.startsWith('return') || mode.startsWith('abort')) {
		fixture.source.resolve(42);
		assert.equal(await fixture.source.promise, 42);
		if (fixture.result) {
			assert.deepEqual(await fixture.result.tail.next(), { done: true, value: undefined });
		}
	}
}

test.each(['return', 'abort', 'return retained', 'abort retained'])(
	'%s releases the graph while its native source stays pending',
	(mode) => {
		in_subprocess(retention, { expose_gc: true, data: mode });
	}
);

test('natural completion releases the input graph with the result retained', () => {
	in_subprocess(retention, { expose_gc: true, data: 'complete' });
});

test('a no-promise head with a replacer releases the graph with the result retained', () => {
	in_subprocess(retention, { expose_gc: true, data: 'plain replacer' });
});

test('control: the same graph collects without a stream retaining it', () => {
	in_subprocess(retention, { expose_gc: true, data: 'sanity' });
});

test('control: a live stream with an externally held input keeps its graph', () => {
	in_subprocess(retention, { expose_gc: true, data: 'live' });
});

async function callback_retention({ assert, vm, turn, unevalStream, data: callback }) {
	assert.equal(typeof global.gc, 'function');
	let reports = 0;

	function create_result() {
		const graph = { nodes: Array.from({ length: 1000 }, (_, i) => ({ i })), visits: 0 };
		const weak = new WeakRef(graph);
		const replacer = () => {
			graph.visits += 1;
			return undefined;
		};
		const onerror = () => {
			reports += graph.nodes.length;
		};
		const options = callback === 'onerror' ? { onerror } : {};
		// The graph is callback-only data, never an input node or cached replacement.
		const result = unevalStream(
			callback === 'replacer' ? { value: 42 } : Promise.resolve(42),
			callback === 'replacer' ? replacer : undefined,
			options
		);
		if (callback === 'replacer') assert.ok(graph.visits > 0);
		// No caller-held graph, callback or options reference escapes this helper.
		return { weak, result };
	}

	const fixture = create_result();
	const context = vm.createContext({});
	const root = vm.runInContext(`(${fixture.result.head})`, context);
	for await (const block of fixture.result.tail) vm.runInContext(block, context);
	if (callback === 'replacer') assert.equal(root.value, 42);
	else assert.equal(await root, 42);
	assert.equal(reports, 0, 'supported outcomes must not invoke onerror');

	// No reporter is active; a retained terminal result must release its callbacks.
	// As above, do not deref until all GCs have run in separate jobs.
	for (let i = 0; i < 20; i += 1) {
		await turn();
		global.gc();
	}
	assert.ok(fixture.result.head.length, 'the terminal result remains externally held');
	assert.ok(
		fixture.weak.deref() === undefined,
		`terminal result retained the ${callback} callback's otherwise unreferenced graph`
	);
}

test.each(['replacer', 'onerror'])(
	'a retained terminal result releases graph-capturing %s callbacks',
	(callback) => in_subprocess(callback_retention, { expose_gc: true, data: callback })
);

test('control: a retained terminal result does not retain an unrelated helper graph', () => {
	in_subprocess(callback_retention, { expose_gc: true, data: 'none' });
});

test('a live stream retains identities until the final delivery', () => {
	in_subprocess(
		async ({ assert, vm, turn, unevalStream }) => {
			function create_result() {
				const source = Promise.withResolvers();
				const graph = { node: {}, pending: source.promise };
				return { source, weak: new WeakRef(graph), result: unevalStream(graph) };
			}
			const fixture = create_result();
			const context = vm.createContext({});
			const root = vm.runInContext(`(${fixture.result.head})`, context);
			for (let i = 0; i < 20; i += 1) {
				await turn();
				global.gc();
			}
			const graph = fixture.weak.deref();
			assert.ok(graph, 'the active session must retain identities without caller-held input');
			fixture.source.resolve({ root: graph, node: graph.node });
			for await (const block of fixture.result.tail) vm.runInContext(block, context);
			const delivered = await root.pending;
			assert.equal(delivered.root, root);
			assert.equal(delivered.node, root.node);
			assert.equal(Object.keys(context.__d).length, 0, 'final block deletes the client session');
		},
		{ expose_gc: true }
	);
});

test.each(['return', 'abort'])(
	'%s releases queued outcomes and wakes ordered concurrent readers',
	(mode) => {
		in_subprocess(
			async ({ assert, turn, unevalStream, data: mode }) => {
				function create_result(signal) {
					const queued = Promise.withResolvers();
					const pending = Promise.withResolvers();
					const graph = { node: {} };
					const result = unevalStream(
						{ queued: queued.promise, pending: pending.promise },
						undefined,
						{ signal }
					);
					queued.resolve(graph);
					return { result, pending, weak: new WeakRef(graph) };
				}
				const controller = new AbortController();
				const fixture = create_result(controller.signal);
				// Use a separate pending stream to check ordered wakeup and exact reason,
				// while the first stream has an undelivered graph-bearing outcome.
				const waiting = unevalStream(fixture.pending.promise, undefined, {
					signal: controller.signal
				});
				const readers = [waiting.tail.next(), waiting.tail.next(), waiting.tail.next()];
				await turn();
				if (mode === 'abort') {
					const reason = { message: 'exact abort reason' };
					controller.abort(reason);
					await assert.rejects(readers[0], (error) => error === reason);
				} else {
					await fixture.result.tail.return();
					await waiting.tail.return();
					assert.deepEqual(await readers[0], { done: true, value: undefined });
				}
				for (const reader of readers.slice(1)) {
					assert.deepEqual(await reader, { done: true, value: undefined });
				}
				if (mode === 'abort') {
					await assert.rejects(
						fixture.result.tail.next(),
						(error) => error === controller.signal.reason
					);
				}
				for (let i = 0; i < 20; i += 1) {
					await turn();
					global.gc();
				}
				assert.ok(fixture.weak.deref() === undefined, 'terminal queue releases its outcome');
				assert.ok(fixture.pending.promise instanceof Promise, 'source is still externally held');
				fixture.pending.resolve(42);
				assert.equal(await fixture.pending.promise, 42);
				assert.deepEqual(await waiting.tail.next(), { done: true, value: undefined });
			},
			{ expose_gc: true, data: mode }
		);
	}
);

test.each(['return', 'abort'])(
	'synchronous %s during a replacer cannot republish terminal state',
	(mode) => {
		in_subprocess(
			async ({ assert, turn, unevalStream, data: mode }) => {
				function create_result() {
					const source = Promise.withResolvers();
					const pending = Promise.withResolvers();
					const controller = new AbortController();
					const graph = { node: {}, pending: pending.promise, text: 'long text '.repeat(100) };
					let result;
					result = unevalStream(
						source.promise,
						(thing) => {
							if (thing === graph) {
								if (mode === 'return') result.tail.return();
								else controller.abort(0);
							}
							return undefined;
						},
						{ signal: controller.signal }
					);
					source.resolve(graph);
					return { result, pending, weak: new WeakRef(graph) };
				}
				const fixture = create_result();
				await fixture.result.tail.next();
				if (mode === 'abort') {
					await assert.rejects(fixture.result.tail.next(), (error) => error === 0);
				}
				assert.deepEqual(await fixture.result.tail.next(), { done: true, value: undefined });
				for (let i = 0; i < 20; i += 1) {
					await turn();
					global.gc();
				}
				assert.ok(fixture.result.head.length, 'terminal result stays reachable');
				assert.ok(fixture.weak.deref() === undefined, 'emission did not republish the graph');
				assert.ok(fixture.pending.promise instanceof Promise, 'nested source is still held');
				fixture.pending.resolve(42);
				assert.equal(await fixture.pending.promise, 42);
			},
			{ expose_gc: true, data: mode }
		);
	}
);
