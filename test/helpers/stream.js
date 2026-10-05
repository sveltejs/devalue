import vm from 'node:vm';
import { expect } from 'vitest';
import { unevalStream } from '../../src/index.js';

const DEFAULT_ORDERS = ['fifo', 'lifo', 'all-at-once', 'seeded-shuffle'];

/**
 * A fresh VM realm, with optional injected globals (e.g. classes used by a replacer)
 * @param {Record<string, unknown>} [globals]
 */
export function client(globals = {}) {
	const context = vm.createContext({ ...globals });
	context.globalThis = context;
	return {
		context,
		/** @param {string} source */
		head: (source) => vm.runInContext(`(${source})`, context),
		/** @param {string} source */
		block: (source) => vm.runInContext(source, context),
		/**
		 * Evaluates the head and every block as one script
		 * @param {string} head
		 * @param {string[]} blocks
		 */
		combined: (head, blocks) =>
			vm.runInContext(`(function(){const root=(${head});${blocks.join('')}return root})()`, context)
	};
}

/** @param {number} seed */
export function seeded_random(seed) {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

/**
 * @template T
 * @param {T[]} values
 * @param {() => number} random
 */
export function shuffle(values, random) {
	for (let i = values.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[values[i], values[j]] = [values[j], values[i]];
	}
	return values;
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * `later(value, ms?)` / `later_reject(reason, ms?)` create promises that settle when
 * `settle_in(order)` runs, or after `ms` milliseconds once it starts if `ms` is given
 */
export function create_schedule() {
	/** @type {Array<() => void>} */
	const ordered = [];
	/** @type {Array<{ settle: () => void, ms: number }>} */
	const timed = [];

	/**
	 * @param {boolean} ok
	 * @param {unknown} value
	 * @param {number} [ms]
	 */
	function create(ok, value, ms) {
		const { promise, resolve, reject } = Promise.withResolvers();
		// rejections nested in outcomes are only observed once the outcome is emitted
		promise.catch(() => {});
		const settle = () => (ok ? resolve(value) : reject(value));
		if (ms === undefined) ordered.push(settle);
		else timed.push({ settle, ms });
		return promise;
	}

	return {
		/** @param {unknown} value @param {number} [ms] */
		later: (value, ms) => create(true, value, ms),
		/** @param {unknown} reason @param {number} [ms] */
		later_reject: (reason, ms) => create(false, reason, ms),
		/** @param {string} order */
		async settle_in(order) {
			const timers = timed.map(({ settle, ms }) =>
				new Promise((r) => setTimeout(r, ms)).then(settle)
			);
			const settles =
				order === 'lifo'
					? ordered.slice().reverse()
					: order === 'seeded-shuffle'
						? shuffle(ordered.slice(), seeded_random(ordered.length + 1))
						: ordered;
			if (order === 'all-at-once') {
				for (const settle of settles) settle();
			} else {
				for (const settle of settles) {
					settle();
					await turn();
				}
			}
			await Promise.all(timers);
		}
	};
}

/** @param {unknown} value */
const type_of = (value) => Object.prototype.toString.call(value).slice(8, -1);

/** @param {unknown} value */
const is_object = (value) =>
	value !== null && (typeof value === 'object' || typeof value === 'function');

/** @param {PromiseLike<unknown>} promise */
const outcome = (promise) =>
	Promise.resolve(promise).then(
		(value) => ({ ok: true, value }),
		(value) => ({ ok: false, value })
	);

/** @param {ArrayBufferLike} buffer @param {number} [offset] @param {number} [length] */
const bytes = (buffer, offset, length) => Array.from(new Uint8Array(buffer, offset, length));

/**
 * Compares a server value with its revived client counterpart: structure, prototypes,
 * key order, and identity (repeated server objects must map to one client object, and
 * distinct ones must not collapse). Promises match when their settled outcomes match.
 * @param {any} server
 * @param {any} revived
 * @param {string} [label]
 * @param {Map<unknown, unknown>} [server_to_client]
 * @param {WeakMap<object, unknown>} [client_to_server]
 * @returns {Promise<void>}
 */
export async function compare_topology(
	server,
	revived,
	label = 'root',
	server_to_client = new Map(),
	client_to_server = new WeakMap()
) {
	if (!is_object(server)) {
		expect(Object.is(revived, server), `${label}: primitive values differ`).toBe(true);
		return;
	}
	if (server_to_client.has(server)) {
		expect(revived, `${label}: repeated identity differs`).toBe(server_to_client.get(server));
		return;
	}
	expect(is_object(revived), `${label}: expected an object`).toBe(true);
	expect(client_to_server.has(revived), `${label}: distinct server nodes collapsed`).toBe(false);
	server_to_client.set(server, revived);
	client_to_server.set(revived, server);

	/** @param {unknown} s @param {unknown} c @param {string} suffix */
	const recurse = (s, c, suffix) =>
		compare_topology(s, c, label + suffix, server_to_client, client_to_server);

	const type = type_of(server);
	expect(type_of(revived), `${label}: type differs`).toBe(type);

	if (type === 'Promise') {
		const [s, c] = await Promise.all([outcome(server), outcome(revived)]);
		expect(c.ok, `${label}: settlement kind differs`).toBe(s.ok);
		return recurse(s.value, c.value, s.ok ? '<resolved>' : '<rejected>');
	}
	if (['String', 'Number', 'Boolean', 'BigInt', 'Date'].includes(type)) {
		expect(Object.is(revived.valueOf(), server.valueOf()), `${label}: boxed value differs`).toBe(
			true
		);
		return;
	}
	if (['RegExp', 'URL', 'URLSearchParams'].includes(type)) {
		expect(String(revived), `${label}: value differs`).toBe(String(server));
		return;
	}
	if (type === 'ArrayBuffer') {
		expect(bytes(revived), `${label}: buffer bytes differ`).toEqual(bytes(server));
		return;
	}
	if (ArrayBuffer.isView(server)) {
		expect(bytes(revived.buffer, revived.byteOffset, revived.byteLength)).toEqual(
			bytes(server.buffer, server.byteOffset, server.byteLength)
		);
		// a Node Buffer's pooled backing store is never sent
		if (Buffer.isBuffer(server)) return;
		expect(revived.byteOffset, `${label}: view offset differs`).toBe(server.byteOffset);
		return recurse(server.buffer, revived.buffer, '.buffer');
	}
	if (type === 'Map' || type === 'Set') {
		const s = Array.from(server.entries());
		const c = Array.from(revived.entries());
		expect(c.length, `${label}: size differs`).toBe(s.length);
		for (let i = 0; i < s.length; i += 1) {
			await recurse(s[i][0], c[i][0], `.key[${i}]`);
			if (type === 'Map') await recurse(s[i][1], c[i][1], `.value[${i}]`);
		}
		return;
	}

	const proto = Object.getPrototypeOf(server);
	const revived_proto = Object.getPrototypeOf(revived);
	if (proto === null || proto === Object.prototype || proto === Array.prototype) {
		expect(revived_proto?.constructor?.name ?? null, `${label}: prototype differs`).toBe(
			proto?.constructor.name ?? null
		);
	} else {
		expect(revived_proto, `${label}: class differs`).toBe(proto);
	}
	if (Array.isArray(server)) expect(revived.length, `${label}: length differs`).toBe(server.length);

	const keys = Object.keys(server);
	expect(Object.keys(revived), `${label}: keys differ`).toEqual(keys);
	for (const key of keys) await recurse(server[key], revived[key], `[${JSON.stringify(key)}]`);
}

/**
 * Serializes `make(schedule)` once per settlement order, evaluates the result in fresh
 * realms (block by block, and concatenated), and checks everything the contract promises.
 * @param {(schedule: ReturnType<typeof create_schedule>) => unknown} make
 * @param {{
 *   replacer?: import('../../src/types.js').UnevalReplacer,
 *   globals?: Record<string, unknown>,
 *   orders?: string[]
 * }} [options]
 */
export async function expect_roundtrip(make, { replacer, globals, orders = DEFAULT_ORDERS } = {}) {
	/** @type {Set<string>} */
	const heads = new Set();
	/** @type {{ head: string, blocks: string[], root: unknown }} */
	let result = { head: '', blocks: [], root: undefined };

	for (const order of orders) {
		const schedule = create_schedule();
		const value = make(schedule);

		/** @type {Map<unknown, number>} */
		const calls = new Map();
		/** @type {import('../../src/types.js').UnevalReplacer} */
		const counted = (v, js) => {
			calls.set(v, (calls.get(v) ?? 0) + 1);
			return replacer?.(v, js);
		};

		const { head, tail } = unevalStream(value, counted, { id: 'roundtrip' });
		heads.add(head);

		/** @type {string[]} */
		const blocks = [];
		const consumed = (async () => {
			for await (const block of tail) blocks.push(block);
		})();
		await schedule.settle_in(order);
		await consumed;

		const separate = client(globals);
		const root = separate.head(head);
		for (const block of blocks) separate.block(block);
		await compare_topology(value, root, `${order} (separate)`);

		const concatenated = client(globals);
		await compare_topology(value, concatenated.combined(head, blocks), `${order} (concatenated)`);

		for (const [v, n] of calls) expect(n, `${order}: replacer calls for ${type_of(v)}`).toBe(1);
		for (const { context } of [separate, concatenated]) {
			expect(Object.keys(context.__d ?? {}), `${order}: session not deleted`).toEqual([]);
		}

		result = { head, blocks, root };
	}

	expect(heads.size, 'head depends on settlement order').toBe(1);
	return result;
}
