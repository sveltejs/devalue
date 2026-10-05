import vm from 'node:vm';
import { expect, test, vi } from 'vitest';
import { unevalStream } from '../src/index.js';
import { client, expect_roundtrip, seeded_random, shuffle } from './helpers/stream.js';

test.each([
	{
		name: 'cycle',
		make: () => {
			const a = {};
			a.self = a;
			return a;
		}
	},
	{
		name: 'head → outcome identity',
		make: ({ later }) => {
			const s = {};
			return { s, p: later(s) };
		}
	},
	{
		name: 'outcome → outcome identity',
		make: ({ later }) => {
			const s = {};
			return [later(s), later({ s })];
		}
	},
	{ name: 'nested promises', make: ({ later }) => ({ p: later({ q: later({ r: later(1) }) }) }) },
	{
		name: 'cycle through outcome',
		make: ({ later }) => {
			const root = {};
			root.p = later({ root });
			return root;
		}
	},
	{
		name: 'rejection identity',
		make: ({ later_reject }) => {
			const e = { code: 1 };
			return { e, p: later_reject(e) };
		}
	},
	{
		name: 'map key identity',
		make: ({ later }) => {
			const k = {};
			return { m: new Map([[k, 1]]), p: later(k) };
		}
	},
	{
		name: 'set member identity',
		make: ({ later }) => {
			const k = {};
			return { s: new Set([k]), p: later(k) };
		}
	},
	{
		name: 'typed view buffer identity',
		make: ({ later }) => {
			const b = new ArrayBuffer(4);
			return { v: new Uint8Array(b), p: later(b) };
		}
	},
	{
		name: 'sparse + null-proto',
		make: ({ later }) => {
			const a = Array(5);
			a[3] = 'x';
			return { p: later(Object.assign(Object.create(null), { a })) };
		}
	},
	{ name: 'promise inside map value', make: ({ later }) => ({ m: new Map([['k', later(2)]]) }) },
	{
		name: 'same promise twice',
		make: ({ later }) => {
			const p = later(1);
			return [p, p, { p }];
		}
	}
])('$name', ({ make }) => expect_roundtrip(make));

class Box {
	/** @param {unknown} value */
	constructor(value) {
		this.value = value;
	}
}

class Job {
	/** @param {Promise<unknown>} completion */
	constructor(completion) {
		this.completion = completion;
	}
}

class Cyclic {
	/** @param {unknown} [meta] */
	constructor(meta) {
		this.meta = meta;
	}
}

class MyThenable {
	/** @param {Promise<unknown>} promise */
	constructor(promise) {
		this.promise = promise;
	}
	/** @type {Promise<unknown>['then']} */
	then(resolve, reject) {
		return this.promise.then(resolve, reject);
	}
}

/** @type {import('../src/types.js').UnevalReplacer} */
const replacer = (v, js) => {
	if (v instanceof Box) return js`new Box(${v.value})`;
	if (v instanceof Job) return js`new Job(${v.completion})`;
	if (v instanceof Cyclic) return js`new Cyclic(${v.meta})`;
	if (v instanceof MyThenable) return js`new MyThenable(${Promise.resolve(v)})`;
};

test.each([
	{
		name: 'replaced object in head',
		make: ({ later }) => {
			const b = new Box({ x: 1 });
			return { b, p: later(b) };
		}
	},
	{ name: 'replaced object in outcome', make: ({ later }) => ({ p: later(new Box({ x: 1 })) }) },
	{ name: 'replaced object wrapping a promise', make: ({ later }) => [new Job(later({ ok: 1 }))] },
	{
		name: 'replaced object whose hole is a head object',
		make: ({ later }) => {
			const s = {};
			return { s, p: later(new Box(s)) };
		}
	},
	{
		name: 'cycle through a replaced object',
		make: ({ later }) => {
			const c = new Cyclic();
			c.meta = { parent: c };
			return { c, p: later(c.meta), q: later(new Cyclic([1])) };
		}
	},
	{
		name: 'custom thenable rebuilt on the client',
		make: ({ later }) => {
			const t = new MyThenable(later({ y: 2 }));
			return { t, again: t, p: later(t) };
		}
	}
])('replacer: $name', ({ make }) =>
	expect_roundtrip(make, { replacer, globals: { Box, Job, Cyclic, MyThenable } })
);

class MatrixWrapper {
	/** @param {string} kind @param {unknown} value */
	constructor(kind, value) {
		this.kind = kind;
		this.value = value;
	}
}

/**
 * @param {number} seed
 * @param {(value: unknown) => Promise<unknown>} later
 */
function build_matrix_case(seed, later) {
	const random = seeded_random(seed);
	const nodes = Array.from({ length: 8 }, (_, index) => ({
		index,
		label: `node-${seed}-${index}`,
		/** @type {unknown} */
		next: null
	}));
	for (let i = 0; i < nodes.length; i += 1) {
		nodes[i].next = nodes[(i + 1 + Math.floor(random() * 3)) % nodes.length];
	}

	const shared = nodes[Math.floor(random() * nodes.length)];
	const distinct = { index: shared.index, label: shared.label, next: shared.next };
	const null_object = Object.assign(Object.create(null), { kind: 'null', shared, distinct });
	const sparse = Array(7);
	sparse[1] = shared;
	sparse[4] = null_object;
	const buffer = new ArrayBuffer(12);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 17 + i * 29) & 255;
	const view = new Uint16Array(buffer, 2, 4);
	const wrapped = new MatrixWrapper(`wrapper-${seed}`, shared);
	const map = new Map(
		shuffle(
			[
				[shared, view],
				[null_object, sparse],
				[distinct, buffer]
			],
			random
		)
	);
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
		set: new Set([distinct, outcome_a, buffer]),
		inner: later(new MatrixWrapper('late', nodes[seed % nodes.length]))
	});
	const entries = shuffle(
		[
			['seed', seed],
			['numeric', { 0: '0', 12: '12', '001': '001' }],
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
			['promises', [outcome_a, outcome_b, outcome_a].map((o) => later(o))]
		],
		random
	);
	return Object.fromEntries(entries);
}

test.each(Array.from({ length: 20 }, (_, i) => ({ seed: i + 1 })))(
	'random graph (seed $seed)',
	({ seed }) =>
		expect_roundtrip(({ later }) => build_matrix_case(seed, later), {
			replacer: (v, js) =>
				v instanceof MatrixWrapper ? js`new MatrixWrapper(${v.kind},${v.value})` : undefined,
			globals: { MatrixWrapper }
		})
);

test('recognizes only branded native promises across realms and subclasses', async () => {
	class SubPromise extends Promise {}
	await expect_roundtrip(() => [
		Promise.resolve(1),
		vm.runInNewContext('Promise.resolve(2)'),
		SubPromise.resolve(3)
	]);

	expect(() => unevalStream({ [Symbol.toStringTag]: 'Promise', then() {} })).toThrow(
		/Cannot stringify/
	);
});

test('calls the replacer once per identity, even after a failed outcome', async () => {
	class X {
		constructor() {
			this.value = 42;
		}
	}
	const x = new X();
	/** @type {unknown[]} */
	const seen = [];
	const onerror = vi.fn();

	const a = Promise.withResolvers();
	const b = Promise.withResolvers();
	const stream = unevalStream(
		{ p1: a.promise, p2: b.promise },
		(value, js) => {
			seen.push(value);
			if (value instanceof X) return js`{value:${value.value}}`;
		},
		{ onerror }
	);

	const c = client();
	const root = c.head(stream.head);

	a.resolve({ x, fn: () => {} });
	c.block(/** @type {string} */ ((await stream.tail.next()).value));
	b.resolve(x);
	c.block(/** @type {string} */ ((await stream.tail.next()).value));

	expect(seen.filter((v) => v === x)).toHaveLength(1);
	await expect(root.p1).rejects.toThrow('devalue: failed to serialize asynchronous value');
	expect(await root.p2).toEqual({ value: 42 });
	expect(onerror).toHaveBeenCalledOnce();
	expect((await stream.tail.next()).done).toBe(true);
});

test('head is deterministic regardless of settlement timing', () => {
	const settled = unevalStream({ a: [1], p: Promise.resolve(1) }, undefined, { id: 'x' });
	const unsettled = unevalStream({ a: [1], p: new Promise(() => {}) }, undefined, { id: 'x' });

	expect(settled.head).toBe(unsettled.head);
});

test('folds settled promises via the replacer', async () => {
	const unhandled = vi.fn();
	process.on('unhandledRejection', unhandled);

	try {
		const shared = { x: 1 };
		const ok = Promise.resolve(shared);
		const bad = Promise.reject(shared);
		bad.catch(() => {});

		/** @type {Map<unknown, { ok: boolean, value?: unknown, reason?: unknown }>} */
		const settled = new Map([
			[ok, { ok: true, value: shared }],
			[bad, { ok: false, reason: shared }]
		]);
		/**
		 * This is just a simple helper to create a rejected promise that doesn't throw an unhandled rejection
		 * @type {(reason: unknown, js: import('../src/types.js').JavaScriptTag) => any}
		 */
		const rejected = (reason, js) => js`(p => (p.catch(() => {}), p))(Promise.reject(${reason}))`;

		const { root, blocks } = await expect_roundtrip(() => ({ shared, ok, bad }), {
			replacer: (v, js) => {
				const r = settled.get(v);
				if (r) return r.ok ? js`Promise.resolve(${r.value})` : rejected(r.reason, js);
			},
			orders: ['fifo']
		});

		expect(blocks).toHaveLength(0);
		await new Promise((r) => setTimeout(r, 10));
		expect(unhandled).not.toHaveBeenCalled();
		const revived = /** @type {any} */ (root);
		expect(await revived.ok).toBe(revived.shared);
	} finally {
		process.off('unhandledRejection', unhandled);
	}
});

test('emits a plain expression when there are no promises', async () => {
	const stream = unevalStream({ x: 1 });
	const c = client();

	expect(stream.head).not.toContain('__d');
	expect(c.head(stream.head)).toEqual({ x: 1 });
	expect((await stream.tail.next()).done).toBe(true);
	expect(c.context.__d).toBeUndefined();
});

test('return() completes a pending next()', async () => {
	const stream = unevalStream({ p: new Promise(() => {}) });
	const next = stream.tail.next();

	expect(await stream.tail.return()).toEqual({ done: true, value: undefined });
	expect(await next).toEqual({ done: true, value: undefined });
});

test('abort rejects a pending next() with the exact reason', async () => {
	const controller = new AbortController();
	const stream = unevalStream({ p: new Promise(() => {}) }, undefined, {
		signal: controller.signal
	});
	const next = stream.tail.next();
	controller.abort(0);

	await expect(next).rejects.toBe(0);
	expect(await stream.tail.next()).toEqual({ done: true, value: undefined });
});

test.each([{ promises: true }, { promises: false }])(
	'abort during head emission throws the exact reason (promises: $promises)',
	({ promises }) => {
		const controller = new AbortController();
		const reason = new Error('abort during head');
		const value = {
			...(promises ? { p: new Promise(() => {}) } : {}),
			get tripwire() {
				controller.abort(reason);
				return 1;
			}
		};

		let result;
		let thrown;
		try {
			result = unevalStream(value, undefined, { signal: controller.signal });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(reason);
		expect(result).toBeUndefined();
	}
);

test('concurrent next() calls settle in order', async () => {
	const a = Promise.withResolvers();
	const b = Promise.withResolvers();
	const stream = unevalStream({ a: a.promise, b: b.promise });
	const c = client();
	const root = c.head(stream.head);

	/** @type {string[]} */
	const order = [];
	const first = stream.tail.next().then((r) => (order.push('first'), r));
	const second = stream.tail.next().then((r) => (order.push('second'), r));
	const third = stream.tail.next().then((r) => (order.push('third'), r));

	b.resolve('b');
	await new Promise((r) => setTimeout(r, 0));
	a.resolve('a');

	const results = await Promise.all([first, second, third]);
	expect(order).toEqual(['first', 'second', 'third']);
	expect(results.map((r) => r.done)).toEqual([false, false, true]);
	for (const r of results.slice(0, 2)) c.block(/** @type {string} */ (r.value));
	expect(await root.a).toBe('a');
	expect(await root.b).toBe('b');
});
