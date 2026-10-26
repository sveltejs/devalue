import { describe, expect, test, vi } from 'vitest';
import { unevalStream } from '../src/index.js';
import { install as host_install } from '../src/uneval-stream/client.js';
import {
	client,
	client_module,
	compare_topology,
	create_schedule,
	load_install
} from './helpers/stream.js';

/**
 * Serializes `make(schedule)` with every promise settled in order, and returns the payloads
 * @param {(schedule: ReturnType<typeof create_schedule>) => unknown} make
 * @param {import('../src/types.js').UnevalStreamOptions} [options]
 */
async function payloads(make, options = {}) {
	const schedule = create_schedule();
	const value = make(schedule);
	const { head, tail, id } = unevalStream(value, undefined, {
		transformError: (error) => error,
		...options
	});
	/** @type {string[]} */
	const blocks = [];
	const consumed = (async () => {
		for await (const block of tail) blocks.push(block);
	})();
	await schedule.settle_in('fifo');
	await consumed;
	return { value, id, messages: [head, ...blocks] };
}

/** @param {ReturnType<typeof create_schedule>} schedule */
const graph = ({ later, later_reject }) => {
	const shared = { shared: true };
	return {
		shared,
		a: later({ shared, nested: later([shared]) }),
		b: later_reject({ code: 1 }),
		c: later(new Map([[shared, later(2)]]))
	};
};

describe('install timing', () => {
	test('install can run before, between or after the payloads', async () => {
		const { value, id, messages } = await payloads(graph, { id: 'timing' });
		expect(messages.length).toBeGreaterThan(3);

		for (let at = 0; at <= messages.length; at += 1) {
			const c = client({}, { install: false });
			for (let i = 0; i < messages.length; i += 1) {
				if (i === at) c.install();
				c.block(messages[i]);
			}
			if (at === messages.length) c.install();

			expect(
				c.receive_calls.map(([id]) => id),
				`install at ${at}`
			).toEqual([id]);
			expect(c.done_ids, `install at ${at}`).toEqual([id]);
			await compare_topology(value, c.received(id), `install at ${at}`);
		}
	});

	test('messages pushed while the queue is being handled are handled in order', () => {
		const c = client({}, { install: false });
		c.block(`
			globalThis.__d = [
				['a', (s, n) => {
					globalThis.__d.push(['c', (s, n) => (n('c'), 1)]);
					return (n('a'), 1);
				}],
				['b', (s, n) => (n('b'), 1)]
			];
		`);
		c.install();
		expect(c.receive_calls).toEqual([
			['a', 'a'],
			['b', 'b'],
			['c', 'c']
		]);
		expect(c.done_ids).toEqual(['a', 'b', 'c']);
	});

	test('done is called exactly once per stream, and only for a message that returns 1', async () => {
		const c = client();
		c.block(`globalThis.__d.push(['x', (s, n) => { n(0) }], ['x', () => 2], ['x', () => true]);`);
		expect(c.done_ids).toEqual([]);
		c.block(`globalThis.__d.push(['x', () => 1]);`);
		expect(c.done_ids).toEqual(['x']);

		const plain = unevalStream({ x: 1 }, undefined, { id: 'plain' });
		c.head(plain.head);
		expect(c.done_ids).toEqual(['x', 'plain']);

		const controller = new AbortController();
		const aborted = unevalStream({ p: new Promise(() => {}) }, undefined, {
			id: 'aborted',
			signal: controller.signal
		});
		const root = c.head(aborted.head);
		const next = aborted.tail.next();
		controller.abort();
		c.block(/** @type {string} */ ((await next).value));
		await expect(root.p).rejects.toThrow('devalue: stream aborted');
		expect(c.done_ids).toEqual(['x', 'plain', 'aborted']);
	});

	test('receive is called once per stream, during the head, before done', async () => {
		/** @type {string[]} */
		const events = [];
		const c = client();
		c.install({
			receive: (id) => events.push(`receive ${id}`),
			done: (id) => events.push(`done ${id}`)
		});

		const plain = unevalStream({ x: 1 }, undefined, { id: 'plain' });
		c.block(plain.head);
		expect(events).toEqual(['receive plain', 'done plain']);

		const { messages } = await payloads(graph, { id: 'graph' });
		c.block(messages[0]);
		expect(events).toEqual(['receive plain', 'done plain', 'receive graph']);
		for (const block of messages.slice(1)) c.block(block);
		expect(events).toEqual(['receive plain', 'done plain', 'receive graph', 'done graph']);
	});

	test('two interleaved streams on one scope', async () => {
		const first = await payloads(graph, { id: 'first' });
		const second = await payloads(graph, { id: 'second' });
		const c = client();
		const length = Math.max(first.messages.length, second.messages.length);
		for (let i = 0; i < length; i += 1) {
			if (i < second.messages.length) c.block(second.messages[i]);
			if (i < first.messages.length) c.block(first.messages[i]);
		}
		expect(c.receive_calls.map(([id]) => id)).toEqual(['second', 'first']);
		expect(c.done_ids.toSorted()).toEqual(['first', 'second']);
		await compare_topology(first.value, c.received('first'), 'first');
		await compare_topology(second.value, c.received('second'), 'second');
	});

	test.each(['same copy', 'second copy'])(
		'a second install (%s) replaces the callbacks',
		async (mode) => {
			const old_stream = await payloads(graph, { id: 'old' });
			const new_stream = await payloads(graph, { id: 'new' });

			const c = client({}, { install: false });
			const install = load_install(c.context);
			const old_callbacks = { receive: vi.fn(), done: vi.fn() };
			install(old_callbacks);
			c.block(old_stream.messages[0]);
			expect(old_callbacks.receive).toHaveBeenCalledOnce();
			const [, old_root] = old_callbacks.receive.mock.calls[0];

			const new_callbacks = { receive: vi.fn(), done: vi.fn() };
			(mode === 'same copy' ? install : load_install(c.context))(new_callbacks);

			for (const message of new_stream.messages) c.block(message);
			for (const message of old_stream.messages.slice(1)) c.block(message);

			expect(old_callbacks.receive).toHaveBeenCalledOnce();
			expect(old_callbacks.done).not.toHaveBeenCalled();
			expect(new_callbacks.receive.mock.calls.map(([id]) => id)).toEqual(['new']);
			expect(new_callbacks.done.mock.calls.map(([id]) => id)).toEqual(['new', 'old']);
			await compare_topology(old_stream.value, old_root, 'old');
			await compare_topology(new_stream.value, new_callbacks.receive.mock.calls[0][1], 'new');
		}
	);

	test('calling install twice with the same callbacks is a no-op', () => {
		const c = client({}, { install: false });
		const install = load_install(c.context);
		const callbacks = { receive: vi.fn(), done: vi.fn() };
		install(callbacks);
		const queue = c.context.__d;
		install(callbacks);
		expect(c.context.__d).toBe(queue);
		c.block(unevalStream({ x: 1 }, undefined, { id: 'x' }).head);
		expect(callbacks.receive).toHaveBeenCalledOnce();
		expect(callbacks.done).toHaveBeenCalledOnce();
	});

	test.each([
		['an object', {}],
		['null', null],
		['a number', 5],
		['a string', 'queue']
	])('install throws on a location holding %s', (_, value) => {
		const target = { q: value };
		expect(() => host_install({ target, key: 'q', receive() {} })).toThrow(
			'devalue: scope is already in use'
		);
		expect(target.q).toBe(value);
	});

	test('installs on different locations do not interfere', async () => {
		const c = client({}, { install: false });
		c.block('globalThis.app = {};');
		const install = load_install(c.context);
		const a = { receive: vi.fn(), done: vi.fn() };
		const b = { receive: vi.fn(), done: vi.fn() };
		install({ ...a, target: c.context.app, key: 'q' });
		install({ ...b, key: Symbol.for('other') });

		c.block(unevalStream(1, undefined, { id: 'a', scope: 'globalThis.app.q' }).head);
		c.block(unevalStream(2, undefined, { id: 'b', scope: 'globalThis[Symbol.for("other")]' }).head);
		expect(a.receive.mock.calls).toEqual([['a', 1]]);
		expect(b.receive.mock.calls).toEqual([['b', 2]]);
		expect(a.done.mock.calls).toEqual([['a']]);
		expect(b.done.mock.calls).toEqual([['b']]);
		expect(c.context.__d).toBeUndefined();
	});
});

describe('runtime', () => {
	test('a promise rejected before anything handles it is not an unhandled rejection', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const { messages } = await payloads(({ later_reject }) => ({ p: later_reject(1) }));
			const c = client();
			for (const message of messages) c.block(message);
			await new Promise((r) => setTimeout(r, 10));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	test('settled promises leave holes, and an abort rejects only those still pending', async () => {
		const controller = new AbortController();
		const a = Promise.withResolvers();
		const stream = unevalStream(
			{ a: a.promise, b: new Promise(() => {}), c: new Promise(() => {}) },
			undefined,
			{ signal: controller.signal }
		);
		const c = client();
		const root = c.head(stream.head);
		a.resolve(1);
		c.block(/** @type {string} */ ((await stream.tail.next()).value));
		const state = c.state(stream.id);
		expect(state.p).toHaveLength(3);
		expect(Object.keys(state.p)).toEqual(['1', '2']);

		const settled = vi.fn();
		const [, reject] = state.p[1];
		state.p[1][1] = (/** @type {unknown} */ reason) => (settled(reason), reject(reason));

		const next = stream.tail.next();
		controller.abort();
		const last = /** @type {string} */ ((await next).value);
		expect(last).toBe(`globalThis.__d.push([${JSON.stringify(stream.id)},(s)=>{s.a();return 1}]);`);
		c.block(last);

		expect(await root.a).toBe(1);
		expect(settled).toHaveBeenCalledOnce();
		await expect(root.b).rejects.toThrow('devalue: stream aborted');
		await expect(root.c).rejects.toThrow('devalue: stream aborted');
	});

	test('a failed settlement uses s.f()', async () => {
		const stream = unevalStream({ p: Promise.reject(new Error('secret')) }, undefined, {
			id: 'failed'
		});
		const c = client();
		const root = c.head(stream.head);
		const blocks = [];
		for await (const block of stream.tail) blocks.push(block);
		expect(blocks).toEqual(['globalThis.__d.push(["failed",(s)=>{s.r(0,1,s.f());return 1}]);']);
		for (const block of blocks) c.block(block);
		const reason = await root.p.catch((/** @type {unknown} */ e) => e);
		expect(reason).toBeInstanceOf(c.block('Error'));
		expect(reason.message).toBe('devalue: failed to serialize asynchronous value');
	});

	test('code a replacer emitted runs before reactions to promises settled earlier in its block', async () => {
		class Marker {}
		/** @type {string[]} */
		const log = [];
		const stream = unevalStream(
			{ a: Promise.resolve(1), b: Promise.resolve(new Marker()) },
			(v, js) => (v instanceof Marker ? js`(log.push('replacer'),1)` : undefined)
		);
		const c = client({ log });
		const root = c.head(stream.head);
		root.a.then(() => log.push('reaction'));
		const blocks = [];
		for await (const block of stream.tail) blocks.push(block);
		expect(blocks).toHaveLength(1);
		c.block(blocks[0]);
		expect(log).toEqual(['replacer']);
		await root.b;
		expect(log).toEqual(['replacer', 'reaction']);
	});

	test('a block for an unknown id after install is reported, and its state is dropped', () => {
		const reportError = vi.fn();
		const c = client({ reportError });
		c.block(`globalThis.__d.push(['stray', (s) => { s.o[0] = 'poison'; s.r(0, 0, 1) }]);`);
		expect(reportError).toHaveBeenCalledOnce();
		expect(reportError.mock.calls[0][0]).toBeInstanceOf(c.block('TypeError'));

		c.head(unevalStream({ p: new Promise(() => {}) }, undefined, { id: 'stray' }).head);
		expect(c.received('stray')).toBeDefined();
		expect(c.state('stray').o[0]).not.toBe('poison');
	});

	test('a block for an unknown id before install throws at the script', async () => {
		const { messages } = await payloads(({ later }) => ({ p: later(1) }));
		const c = client({}, { install: false });
		expect(() => c.block(messages[1])).toThrow(c.block('TypeError'));
	});

	test('a message whose fn throws is reported, and the rest of the queue is handled', () => {
		const reportError = vi.fn();
		const c = client({ reportError }, { install: false });
		c.block(`
			globalThis.__d = [
				['bad', () => { throw new Error('bad message') }],
				['good', (s, n) => (n('good'), 1)]
			];
		`);
		c.install();
		expect(reportError).toHaveBeenCalledOnce();
		expect(reportError.mock.calls[0][0].message).toBe('bad message');
		expect(c.receive_calls).toEqual([['good', 'good']]);
		expect(c.done_ids).toEqual(['good']);

		// and a push after install doesn't throw at the script that sent it
		expect(() => c.block(`globalThis.__d.push(['bad', () => { throw 1 }]);`)).not.toThrow();
		expect(reportError).toHaveBeenCalledTimes(2);
	});

	test('an error thrown by receive is reported, and the head still ends its stream', () => {
		const reportError = vi.fn();
		const error = new Error('receive failed');
		const c = client({ reportError });
		const done = vi.fn();
		c.install({
			receive: () => {
				throw error;
			},
			done
		});
		c.block(unevalStream({ x: 1 }, undefined, { id: 'x' }).head);
		expect(reportError.mock.calls).toEqual([[error]]);
		expect(done.mock.calls).toEqual([['x']]);
	});
});

describe('packaging', () => {
	test('the client module has no imports', () => {
		const code = client_module.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		expect(code).not.toMatch(/\bimport\b/);
		expect(code).not.toMatch(/\brequire\s*\(/);
	});

	test('devalue/uneval-stream/client resolves', async () => {
		const module = await import('devalue/uneval-stream/client');
		expect(module.install).toBe(host_install);
	});

	test('a head with one pending promise is at least 150 bytes shorter than before', () => {
		// The head for this value at 929fabc, before the client runtime moved into a module
		const before =
			'(()=>{let n=globalThis.__d||(globalThis.__d={__proto__:null}),s=(n["abcd1234"]={o:[],p:[]});' +
			's.d=(i)=>{let p=new Promise((a,b)=>{s.p[i]=[a,b]});p.catch(()=>{});return p};' +
			's.r=(i,k,v)=>{s.p[i][k](v);delete s.p[i]};return (s.o[0]={p:s.d(0)})})()';
		const { head } = unevalStream({ p: new Promise(() => {}) }, undefined, { id: 'abcd1234' });
		expect(head).toBe('(globalThis.__d??=[]).push(["abcd1234",(s,n)=>n((s.o[0]={p:s.d(0)}))]);');
		expect(before.length - head.length).toBeGreaterThanOrEqual(150);
	});
});
