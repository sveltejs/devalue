import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import {
	unsafeReducers,
	unsafeReplacer,
	unsafeRevivers,
	parse,
	regexpReducer,
	regexpReplacer,
	regexpReviver,
	sparseArrayReducer,
	sparseArrayReplacer,
	sparseArrayReviver,
	stringify,
	uneval,
	unflatten
} from '../src/index.js';

describe('opt-in unsafe types', () => {
	test('RegExp is rejected by default and supported by exported helpers', () => {
		const value = /a<b/gi;

		expect(() => uneval(value)).toThrow('Cannot stringify a RegExp');
		expect(() => stringify(value)).toThrow('Cannot stringify a RegExp');
		expect(() => parse('[["RegExp","a<b","gi"]]')).toThrow('Cannot parse a RegExp');

		const source = uneval(value, regexpReplacer);
		const from_source = Function(`return (${source})`)();
		expect(from_source.source).toBe(value.source);
		expect(from_source.flags).toBe(value.flags);

		const serialized = stringify(value, { RegExp: regexpReducer });
		const revived = parse(serialized, { RegExp: regexpReviver });
		expect(revived.source).toBe(value.source);
		expect(revived.flags).toBe(value.flags);

		const foreign = vm.runInNewContext('/foreign/gi');
		expect(parse(stringify(foreign, { RegExp: regexpReducer }), { RegExp: regexpReviver })).toEqual(
			/foreign/gi
		);
		expect(Function(`return (${uneval(foreign, regexpReplacer)})`)()).toEqual(/foreign/gi);
	});

	test('sparse arrays are rejected by default and supported by exported helpers', () => {
		const shared = { answer: 42 };
		const value = [];
		value.length = 5;
		Object.defineProperty(value, 2, { value: shared, enumerable: false });
		value[4] = shared;

		expect(() => uneval(value)).toThrow('Cannot stringify a sparse array');
		expect(() => stringify(value)).toThrow('Cannot stringify a sparse array');
		expect(() => unflatten([[-7, 5, 2, 1], shared])).toThrow('Cannot parse a sparse array');

		const source = uneval(value, sparseArrayReplacer);
		const from_source = Function(`return (${source})`)();
		expect(from_source.length).toBe(5);
		expect(Object.keys(from_source)).toEqual(['2', '4']);
		expect(from_source[2]).toBe(from_source[4]);

		const serialized = stringify(value, { SparseArray: sparseArrayReducer });
		const revived = parse(serialized, { SparseArray: sparseArrayReviver });
		expect(revived.length).toBe(5);
		expect(Object.keys(revived)).toEqual(['2', '4']);
		expect(revived[2]).toBe(revived[4]);
	});

	test('sparse array helpers reject direct cycles instead of changing the graph', () => {
		const value = [];
		value.length = 2;
		value[1] = value;

		expect(() => uneval(value, sparseArrayReplacer)).toThrow(
			'Cannot serialize a cyclic sparse array'
		);
		expect(() => stringify(value, { SparseArray: sparseArrayReducer })).toThrow(
			'Cannot serialize a cyclic sparse array'
		);
	});

	test('combined helper collections support both unsafe types', () => {
		const sparse = [, /x/g];
		const source = uneval(sparse, unsafeReplacer);
		const from_source = Function(`return (${source})`)();
		expect(from_source[1]).toEqual(/x/g);

		const serialized = stringify(sparse, unsafeReducers);
		const revived = parse(serialized, unsafeRevivers);
		expect(revived.length).toBe(2);
		expect(0 in revived).toBeFalsy();
		expect(revived[1]).toEqual(/x/g);
	});
});
