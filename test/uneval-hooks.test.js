import { describe, expect, test } from 'vitest';
import { js, JavaScriptSource } from '../src/javascript-source.js';
import { analyze, uneval } from '../src/uneval.js';

/**
 * Evaluates emitted code the way a client would, with `s` bound to its session table.
 * @param {string} source
 * @param {any} session
 */
function evaluate_on_client(source, session) {
	return new Function('s', 'Wrapper', `return (${source})`)(session, Wrapper);
}

/**
 * Builds a hook that returns the expression mapped to an object, or `undefined`.
 * @param {Array<[object, string]>} entries
 */
function expressions_for(entries) {
	const map = new Map(entries);
	return (/** @type {object} */ thing) => map.get(thing);
}

/**
 * Walks and renders a value in one go.
 * @template T
 * @param {any} value
 * @param {import('../src/uneval.js').AnalyzeHooks<T> & import('../src/uneval.js').RenderHooks<T>} [hooks]
 */
function emit(value, hooks = {}) {
	const { reference, retain, primitive, ...walk_hooks } = hooks;
	return analyze(value, walk_hooks).render({ reference, retain, primitive });
}

/**
 * Builds `known`/`reference` hooks for objects that already exist on the client.
 * The token is the client expression itself.
 * @param {Array<[object, string]>} entries
 */
function existing_hooks(entries) {
	const map = new Map(entries);
	return {
		known: (/** @type {object} */ thing) => map.get(thing),
		reference: (/** @type {string} */ expression) => expression
	};
}

/**
 * @param {string} source
 * @param {string} target
 */
function count_assignments(source, target) {
	return source.split(`${target}=`).length - 1;
}

/**
 * @param {string} source
 * @param {string} name
 */
function declares(source, name) {
	return source.includes(`let ${name}=`);
}

/** An object that throws if `emit` tries to serialize its contents. */
function must_not_be_walked() {
	return {
		get contents() {
			throw new Error('emit walked into an object the client already has');
		}
	};
}

class Wrapper {
	/** @param {any} wrapped */
	constructor(wrapped) {
		this.wrapped = wrapped;
	}
}

/** @param {any} thing */
const replace_wrappers = (thing) =>
	thing instanceof Wrapper ? JavaScriptSource.from(js`new Wrapper(${thing.wrapped})`) : null;

describe('reference', () => {
	test('emits the client expression instead of serializing the object', () => {
		const server_user = must_not_be_walked();
		const client = { user: { name: 'already on the client' } };

		const source = emit(
			{ author: server_user, editor: server_user },
			existing_hooks([[server_user, 's.user']])
		);
		const result = evaluate_on_client(source, client);

		expect(source).toContain('s.user');
		expect(result.author).toBe(client.user);
		expect(result.editor).toBe(client.user);
	});

	test('takes precedence over replace', () => {
		const server_user = new Wrapper('server copy');
		/** @type {unknown[]} */
		const replaced = [];

		emit(
			{ user: server_user },
			{
				...existing_hooks([[server_user, 's.user']]),
				replace: (thing) => {
					replaced.push(thing);
					return replace_wrappers(thing);
				}
			}
		);

		expect(replaced).not.toContain(server_user);
	});
});

describe('replace', () => {
	test('is called once per object, however many times the object is reached', () => {
		const shared = { shared: true };
		const wrapper = new Wrapper(shared);
		/** @type {Map<unknown, number>} */
		const calls = new Map();

		emit(
			{ shared, also_shared: shared, in_array: [shared], wrapper, also_wrapper: wrapper },
			{
				replace: (thing) => {
					calls.set(thing, (calls.get(thing) ?? 0) + 1);
					return replace_wrappers(thing);
				}
			}
		);

		expect(calls.get(shared)).toBe(1);
		expect(calls.get(wrapper)).toBe(1);
	});
});

describe('retain', () => {
	test('stores a Set member in its slot', () => {
		const member = { x: 1 };
		const client = { o: [] };

		const source = emit(new Set([member]), { retain: expressions_for([[member, 's.o[0]']]) });
		const set = evaluate_on_client(source, client);

		expect(client.o[0]).toBe([...set][0]);
	});

	test('stores a cyclic object in its slot exactly once', () => {
		/** @type {any} */
		const cyclic = { x: 1 };
		cyclic.self = cyclic;
		const client = { o: [] };

		const source = emit({ cyclic }, { retain: expressions_for([[cyclic, 's.o[0]']]) });
		const result = evaluate_on_client(source, client);

		expect(client.o[0]).toBe(result.cyclic);
		expect(result.cyclic.self).toBe(result.cyclic);
		expect(count_assignments(source, 's.o[0]')).toBe(1);
	});

	test('stores hoisted objects in their slots exactly once', () => {
		const shared = { x: 1 };
		const map = new Map([[shared, shared]]);
		const client = { o: [] };

		const source = emit(
			{ shared, in_array: [shared], map },
			{
				retain: expressions_for([
					[shared, 's.o[0]'],
					[map, 's.o[1]']
				])
			}
		);
		const result = evaluate_on_client(source, client);

		expect(client.o[0]).toBe(result.shared);
		expect(client.o[1]).toBe(result.map);
		expect(result.in_array[0]).toBe(result.shared);
		expect(result.map.get(result.shared)).toBe(result.shared);
		expect(count_assignments(source, 's.o[0]')).toBe(1);
		expect(count_assignments(source, 's.o[1]')).toBe(1);
	});

	test('stores a replaced object in its slot', () => {
		const wrapper = new Wrapper('contents');
		const client = { o: [] };

		const source = emit(
			{ wrapper },
			{ replace: replace_wrappers, retain: expressions_for([[wrapper, 's.o[0]']]) }
		);
		const result = evaluate_on_client(source, client);

		expect(client.o[0]).toBe(result.wrapper);
		expect(result.wrapper).toBeInstanceOf(Wrapper);
		expect(result.wrapper.wrapped).toBe('contents');
	});

	test("stores a typed array's buffer in its slot", () => {
		const array = new Uint8Array([1, 2, 3]);
		const client = { o: [] };

		const source = emit({ array }, { retain: expressions_for([[array.buffer, 's.o[0]']]) });
		const result = evaluate_on_client(source, client);

		expect(client.o[0]).toBe(result.array.buffer);
		expect([...result.array]).toEqual([1, 2, 3]);
	});
});

describe('enter', () => {
	test('reports each created object once, with the parent and key that reach it', () => {
		const shared = { x: 1 };
		const key = { k: 1 };
		const member = { m: 1 };
		const array = new Uint8Array([1, 2]);
		const wrapper = new Wrapper({ inner: true });
		const value = { shared, again: shared, list: [shared, member], map: new Map([[key, 1]]) };
		Object.assign(value, { set: new Set([member]), array, wrapper, 'odd key': {} });

		/** @type {Array<[unknown, unknown, unknown]>} */
		const calls = [];
		emit(value, {
			replace: replace_wrappers,
			enter: (thing, parent, key) => calls.push([thing, parent, key])
		});

		expect(calls).toEqual([
			[value, undefined, undefined],
			[shared, value, 'shared'],
			[value.list, value, 'list'],
			[member, value.list, 1],
			[value.map, value, 'map'],
			[key, undefined, undefined],
			[value.set, value, 'set'],
			[array, value, 'array'],
			[array.buffer, array, 'buffer'],
			[wrapper, value, 'wrapper'],
			[wrapper.wrapped, undefined, undefined],
			[value['odd key'], value, 'odd key']
		]);
	});

	test('is not called for referenced objects or their contents', () => {
		const existing = { child: {} };
		/** @type {unknown[]} */
		const things = [];

		emit(
			{ existing },
			{
				...existing_hooks([[existing, 's.e']]),
				enter: (thing) => things.push(thing)
			}
		);

		expect(things).not.toContain(existing);
		expect(things).not.toContain(existing.child);
	});

	test('is not called for the pooled buffer of a Node Buffer', () => {
		const buffer = Buffer.from('hi');
		/** @type {unknown[]} */
		const things = [];

		emit({ buffer }, { enter: (thing) => things.push(thing) });

		expect(things).not.toContain(buffer.buffer);
	});
});

describe('reserved', () => {
	test('generated names never shadow identifiers used by hook expressions', () => {
		const server_user = must_not_be_walked();
		const enough_repeats_to_generate_s = Array.from({ length: 100 }, (_, i) => ({ i }));
		const value = {
			user: server_user,
			first: enough_repeats_to_generate_s,
			second: [...enough_repeats_to_generate_s]
		};
		const hooks = existing_hooks([[server_user, 's.user']]);
		const client = { user: { name: 'already on the client' } };

		expect(declares(emit(value, hooks), 's')).toBe(true);

		const source = emit(value, { ...hooks, reserved: ['s'] });
		const result = evaluate_on_client(source, client);

		expect(declares(source, 's')).toBe(false);
		expect(result.user).toBe(client.user);
		expect(result.second[42]).toBe(result.first[42]);
	});
});

describe('analyze', () => {
	/** @type {any} */
	const cyclic = { name: 'cyclic' };
	cyclic.self = cyclic;
	const shared = { shared: true };
	const long = 'x'.repeat(200);
	const sparse = [];
	sparse[100] = 1;

	test.each([
		['number', 42],
		['negative zero', -0],
		['undefined', undefined],
		['string', 'hello <world>'],
		['bigint', 10n ** 140n],
		['object', { a: 1, 'odd key': [1, 2, 3] }],
		['null-prototype object', Object.assign(Object.create(null), { x: 1 })],
		['repeated reference', { a: shared, b: shared, c: [shared] }],
		['cycle', cyclic],
		['repeated long string', [long, long, long]],
		['repeated bigint', [10n ** 140n, 10n ** 140n]],
		['sparse array', sparse],
		['map and set', new Map([[shared, new Set([shared, 1])]])],
		['typed arrays', { a: new Uint8Array([1, 2]), b: new Float64Array([-0, 1.5]) }],
		[
			'shared buffer',
			(() => {
				const buffer = new ArrayBuffer(4);
				return [new Uint8Array(buffer), new DataView(buffer)];
			})()
		],
		['dates and regexps', [new Date(0), /a.b/gi, new URL('https://example.com')]],
		['boxed primitives', [Object(1), Object('s'), Object(true), Object(1n)]]
	])('render() without hooks matches uneval: %s', (_name, value) => {
		expect(analyze(value).render()).toBe(uneval(value));
	});

	test('render() without hooks matches uneval with a replacer', () => {
		const wrapper = new Wrapper(shared);
		const value = { wrapper, again: wrapper, shared };
		/** @param {any} thing @param {any} js */
		const replacer = (thing, js) =>
			thing instanceof Wrapper ? js`new Wrapper(${thing.wrapped})` : null;

		expect(emit(value, { replace: replace_wrappers })).toBe(uneval(value, replacer));
	});

	test('render can only be called once', () => {
		const analysis = analyze({ a: 1 });
		analysis.render();

		expect(() => analysis.render()).toThrow('render() can only be called once');
	});

	test('reference receives the token known returned', () => {
		const first = must_not_be_walked();
		const second = must_not_be_walked();
		const first_token = { slot: 0 };
		const second_token = { slot: 1 };
		const tokens = new Map([
			[first, first_token],
			[second, second_token]
		]);
		/** @type {unknown[]} */
		const received = [];

		const analysis = analyze(
			{ first, second, again: first, other: {} },
			{
				known: (thing) => tokens.get(thing)
			}
		);
		const source = analysis.render({
			reference: (token) => {
				received.push(token);
				return `s.o[${token.slot}]`;
			}
		});

		expect(received).toEqual([first_token, second_token]);
		expect(received[0]).toBe(first_token);
		expect(received[1]).toBe(second_token);
		expect(source).toContain('s.o[0]');
		expect(source).toContain('s.o[1]');
	});

	test('primitive is only called for long strings and bigints with long literals', () => {
		const long_string = 'x'.repeat(128);
		const long_bigint = 10n ** 130n;
		const value = {
			short: 'x'.repeat(127),
			long: long_string,
			small: 123n,
			medium: 10n ** 125n,
			big: long_bigint,
			number: 1,
			boxed: Object('y'.repeat(10))
		};
		/** @type {unknown[]} */
		const calls = [];

		emit(value, {
			primitive: (thing) => {
				calls.push(thing);
				return undefined;
			}
		});

		expect(calls).toEqual([long_string, long_bigint]);
	});
});
