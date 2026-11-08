import { describe, expect, test } from 'vitest';
import { parse, stringify, stringifyAsync } from '../src/index.js';

class Vector {
	/**
	 * @param {number} x
	 * @param {number} y
	 */
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
}

/** @type {Record<string, (value: any) => any>} */
const reducers = { Vector: (value) => value instanceof Vector && [value.x, value.y] };

/** @type {Record<string, (value: any) => any>} */
const revivers = { Vector: ([x, y]) => new Vector(x, y) };

const corpus = [
	{
		name: 'repeated primitives',
		value: () => ({
			small: [0, 1, 1, 1023, 1023],
			large: [1024, 1024, 2 ** 31, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
			fractional: [0.5, 0.5, -1, -1, -1.5, -1.5, 1e21, 1e21],
			strings: ['a', 'a', '', '', '<', '\u2028', '\ud800', '\ud800'],
			other: [true, true, false, false, null, null, 1n, 1n, undefined, undefined]
		})
	},
	{
		name: 'sentinels',
		value: () => [NaN, NaN, -0, -0, Infinity, -Infinity, 0, 0]
	},
	{
		name: 'shared references',
		value: () => {
			const shared = { id: 1, tags: ['a', 'b'] };
			return { first: shared, second: shared, list: [shared, shared] };
		}
	},
	{
		name: 'cycles',
		value: () => {
			/** @type {any} */
			const node = { id: 1, children: [] };
			node.children.push({ id: 2, parent: node });
			node.self = node;
			return node;
		}
	},
	{
		name: 'built-ins',
		value: () => ({
			date: new Date(1700000000000),
			map: new Map([
				[1, 'one'],
				[1024, 1024],
				['key', { nested: 1 }]
			]),
			set: new Set([1, 1024, 0.5, 'x']),
			bytes: new Uint8Array([1, 2, 3]),
			floats: new Float64Array([0.5, 1024]),
			regexp: /a+b/g
		})
	},
	{
		name: 'reducers on objects',
		value: () => {
			const vector = new Vector(1024, 1024);
			return { a: vector, b: vector, c: new Vector(0.5, 0.5), n: 1024 };
		}
	},
	{
		name: 'null-prototype objects',
		value: () => Object.assign(Object.create(null), { a: 1024, b: 1024, c: 'x' })
	},
	{
		name: 'holes',
		value: () => {
			const sparse = [];
			sparse[1000] = 1024;
			// eslint-disable-next-line no-sparse-arrays
			return { dense: [1, , 1024, , 1024], sparse };
		}
	},
	{
		name: 'boxed primitives',
		value: () => {
			const boxed = new Number(1024);
			return [boxed, boxed, new Number(1024), new String('x'), new Boolean(false), Object(1n)];
		}
	},
	{ name: 'root small integer', value: () => 1 },
	{ name: 'root large integer', value: () => 1024 },
	{ name: 'root fraction', value: () => 0.5 },
	{ name: 'root negative zero', value: () => -0 }
];

describe.each([
	{ name: 'stringify', fn: stringify },
	{ name: 'stringifyAsync', fn: stringifyAsync }
])('$name round-trip', ({ fn }) => {
	test.each(corpus)('$name', async ({ value }) => {
		const input = value();
		const output = parse(await fn(input, reducers), revivers);
		expect(output).toStrictEqual(input);
	});

	test('preserves shared references and cycles', async () => {
		const shared = { id: 1 };
		/** @type {any} */
		const node = { shared, again: shared, vector: new Vector(1, 2) };
		node.self = node;

		const output = parse(await fn(node, reducers), revivers);
		expect(output.self).toBe(output);
		expect(output.again).toBe(output.shared);
		expect(output.vector).toBeInstanceOf(Vector);
	});
});

describe('stringify primitives', () => {
	test('deduplicates repeated small non-negative integers', () => {
		expect(stringify([0, 0, 1023, 1023])).toBe('[[1,1,2,2],0,1023]');
	});

	test('deduplicates other repeated numbers', () => {
		expect(stringify([1024, 1024, 0.5, 0.5, -1, -1])).toBe('[[1,1,2,2,3,3],1024,0.5,-1]');
	});

	test('deduplicates repeated strings, booleans, null and bigints', () => {
		expect(stringify(['a', 'a', true, true, null, null, 1n, 1n])).toBe(
			'[[1,1,2,2,3,3,4,4],"a",true,null,["BigInt","1"]]'
		);
	});

	test('encodes special numbers as sentinels', () => {
		expect(stringify([NaN, -0, Infinity, -Infinity, undefined])).toBe('[[-3,-6,-4,-5,-1]]');
		expect(stringify(NaN)).toBe('-3');
		expect(stringify(-0)).toBe('-6');
		expect(stringify(1024)).toBe('[1024]');
	});

	test('calls reducers for objects, functions and symbols only', () => {
		/** @type {string[]} */
		const seen = [];
		const fn = () => {};
		const symbol = Symbol('s');

		const json = stringify(
			{ fn, symbol, s: 'x', n: 1, f: 0.5, b: true, z: null, big: 1n, u: undefined },
			{
				Custom: (value) => {
					seen.push(typeof value);
					return (typeof value === 'function' || typeof value === 'symbol') && 'custom';
				}
			}
		);

		expect(seen).toEqual(['object', 'function', 'symbol']);
		expect(parse(json, { Custom: (value) => value })).toEqual({
			fn: 'custom',
			symbol: 'custom',
			s: 'x',
			n: 1,
			f: 0.5,
			b: true,
			z: null,
			big: 1n,
			u: undefined
		});
	});

	test('calls reducers for boxed primitives', () => {
		const json = stringify([new String('x'), 'x'], {
			Boxed: (value) => value instanceof String && value.valueOf()
		});

		expect(json).toBe('[[1,2],["Boxed",2],"x"]');
	});
});
