import { describe, expect, test } from 'vitest';
import { DevalueError, parse, stringify, stringifyAsync, unflatten } from '../src/index.js';

const strict = { references: false };

describe('stringify with references: false', () => {
	test('does not deduplicate shared objects', () => {
		const shared = { a: 1 };
		const value = { x: shared, y: shared };

		expect(stringify(value, undefined, strict)).toBe('[{"x":1,"y":3},{"a":2},1,{"a":4},1]');

		const result = parse(stringify(value, undefined, strict), undefined, strict);
		expect(result).toEqual(value);
		expect(result.x).not.toBe(result.y);
	});

	test('does not deduplicate primitives', () => {
		const json = stringify(['hello', 'hello', 1, 1], undefined, strict);
		expect(json).toBe('[[1,2,3,4],"hello","hello",1,1]');
		expect(parse(json, undefined, strict)).toEqual(['hello', 'hello', 1, 1]);
	});

	test('copies a buffer shared between views', () => {
		const buffer = new ArrayBuffer(4);
		const value = [new Uint8Array(buffer), new Uint8Array(buffer, 1, 2)];

		const result = parse(stringify(value, undefined, strict), undefined, strict);
		expect(result).toEqual(value);
		expect(result[0].buffer).not.toBe(result[1].buffer);
	});

	test('round-trips built-in types', () => {
		const value = {
			date: new Date(0),
			set: new Set([1, 'a']),
			map: new Map([[{ k: 1 }, [1, 2]]]),
			big: 1n,
			boxed: Object(1n),
			nested: [[[undefined, NaN, -0]]]
		};

		expect(parse(stringify(value, undefined, strict), undefined, strict)).toEqual(value);
	});

	test('throws on a cycle', () => {
		const value = { a: { b: {} } };
		value.a.b.c = value.a;

		let error;
		try {
			stringify(value, undefined, strict);
		} catch (e) {
			error = e;
		}

		expect(error).toBeInstanceOf(DevalueError);
		expect(error.message).toMatch(/circular reference/);
		expect(error.path).toBe('.a.b.c');
	});

	class Box {
		constructor(value) {
			this.value = value;
		}
	}

	const box_reducers = { Box: (v) => v instanceof Box && v.value };

	test('throws on a cycle through a custom reducer', () => {
		const box = new Box(null);
		box.value = [box];

		expect(() => stringify(box, box_reducers, strict)).toThrow(/circular reference/);
	});

	test('serializes a shared custom value once per occurrence', () => {
		const shared = new Box(1);
		const json = stringify([shared, shared], box_reducers, strict);
		const result = parse(json, { Box: (v) => new Box(v) }, strict);
		expect(result).toEqual([new Box(1), new Box(1)]);
		expect(result[0]).not.toBe(result[1]);
	});

	test('stringifyAsync throws on a cycle through a promise', async () => {
		const value = {};
		value.p = Promise.resolve(value);

		await expect(stringifyAsync(value, undefined, strict)).rejects.toThrow(/circular reference/);
	});

	test('stringifyAsync allows a shared promise', async () => {
		const p = Promise.resolve({ a: 1 });
		const json = await stringifyAsync([p, p], undefined, strict);
		expect(parse(json, undefined, strict)).toEqual([{ a: 1 }, { a: 1 }]);
	});

	test('validates the option', () => {
		// @ts-expect-error
		expect(() => stringify(1, undefined, { references: 'no' })).toThrow(TypeError);
	});
});

describe('parse with references: false', () => {
	const repeated = /repeated reference/;

	test('rejects a shared object', () => {
		const shared = { a: 1 };
		const json = stringify([shared, shared]);
		expect(json).toBe('[[1,1],{"a":2},1]');
		expect(() => parse(json, undefined, strict)).toThrow(repeated);
	});

	test('rejects a shared string', () => {
		expect(() => parse('[[1,1],"hello"]', undefined, strict)).toThrow(repeated);
	});

	test('rejects a shared buffer', () => {
		const buffer = new ArrayBuffer(4);
		const json = stringify([new Uint8Array(buffer), new Uint8Array(buffer)]);
		expect(() => parse(json, undefined, strict)).toThrow(repeated);
	});

	test('rejects cycles', () => {
		expect(() => parse('[{"self":0}]', undefined, strict)).toThrow(repeated);
		expect(() => parse('[[1],[0]]', undefined, strict)).toThrow(repeated);
		expect(() => parse('[["Set",0]]', undefined, strict)).toThrow(repeated);
	});

	test('rejects repeated references through a custom reviver', () => {
		const revivers = { Custom: (v) => ({ v }) };
		expect(() => parse('[[1,1],["Custom",2],{"a":3},1]', revivers, strict)).toThrow(repeated);
		expect(() => parse('[[1,2],["Custom",2],{"a":3},1]', revivers, strict)).toThrow(repeated);
		expect(() => parse('[["Custom",0]]', revivers, strict)).toThrow(repeated);
		expect(parse('[[1],["Custom",2],{"a":3},1]', revivers, strict)).toEqual([{ v: { a: 1 } }]);
	});

	test('rejects an exponential payload in linear time', () => {
		const levels = 1000;
		const values = ['[1]'];
		for (let i = 1; i <= levels; i += 1) values.push(`[${i + 1},${i + 1}]`);
		values.push('"leaf"');
		const json = `[${values.join(',')}]`;

		const dag = parse(json);
		expect(dag[0][0]).toBe(dag[0][1]);

		const start = performance.now();
		expect(() => parse(json, undefined, strict)).toThrow(repeated);
		expect(performance.now() - start).toBeLessThan(100);
	});

	test('allows the special negative indexes to repeat', () => {
		expect(parse('[[-1,-1,-3,-3,-6,-6]]', undefined, strict)).toEqual([
			undefined,
			undefined,
			NaN,
			NaN,
			-0,
			-0
		]);
		expect(parse('-1', undefined, strict)).toBe(undefined);
	});

	test('unflatten applies the same rule', () => {
		expect(() => unflatten([[1, 1], 'x'], undefined, strict)).toThrow(repeated);
		expect(unflatten([[1, 2], 'x', 'x'], undefined, strict)).toEqual(['x', 'x']);
	});

	test('the default still allows references', () => {
		const result = parse('[[1,1],{"a":2},1]');
		expect(result[0]).toBe(result[1]);
	});

	test('validates the option', () => {
		// @ts-expect-error
		expect(() => parse('[1]', undefined, { references: 0 })).toThrow(TypeError);
	});
});
