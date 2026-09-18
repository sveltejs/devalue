import { describe, test, expect } from 'vitest';
import { stringify_string, valid_array_indices } from './utils.js';

describe('valid_array_indices', () => {
	test('returns all indices for a normal dense array', () => {
		const arr = ['a', 'b', 'c'];
		expect(valid_array_indices(arr)).toEqual(['0', '1', '2']);
	});

	test('returns empty array for an empty array', () => {
		expect(valid_array_indices([])).toEqual([]);
	});

	test('returns populated indices for a sparse array', () => {
		const arr = [, 'b', ,];
		expect(valid_array_indices(arr)).toEqual(['1']);
	});

	test('strips non-numeric properties from a dense array', () => {
		const arr = ['a', 'b'];
		arr.foo = 'x';
		arr.bar = 42;
		expect(valid_array_indices(arr)).toEqual(['0', '1']);
	});

	test('strips non-numeric properties from a very sparse array', () => {
		const arr = [];
		arr[1_000_000] = 'x';
		arr.foo = 'should be ignored';
		expect(valid_array_indices(arr)).toEqual(['1000000']);
	});

	test('returns empty array when only non-numeric properties exist', () => {
		const arr = [];
		arr.foo = 'x';
		arr.bar = 42;
		expect(valid_array_indices(arr)).toEqual([]);
	});

	test('handles multiple non-numeric properties after indices', () => {
		const arr = [1, 2, 3];
		arr.a = 'x';
		arr.b = 'y';
		arr.c = 'z';
		expect(valid_array_indices(arr)).toEqual(['0', '1', '2']);
	});

	test('handles a single-element array with non-numeric property', () => {
		const arr = ['only'];
		arr.extra = true;
		expect(valid_array_indices(arr)).toEqual(['0']);
	});

	test('handles array properties pretending to be indices', () => {
		const arr = ['a', 'b'];
		arr[-1] = 'negative index';
		arr[2 ** 32 - 1] = 'too large index';
		expect(valid_array_indices(arr)).toEqual(['0', '1']);
	});
});

describe('stringify_string', () => {
	test.each(['\ud800', 'a\ud800b', '\udfff', 'x\udbff', '\udc00y', '\ud800\ud800\udc00'])(
		'escapes unpaired surrogates so output survives UTF-8 transport (%j)',
		(value) => {
			const source = stringify_string(value);
			expect(source.isWellFormed(), source).toBe(true);
			const encoded = new TextDecoder().decode(new TextEncoder().encode(source));
			expect((0, eval)(encoded)).toBe(value);
		}
	);

	test('leaves well-formed surrogate pairs untouched', () => {
		expect(stringify_string('\ud83d\ude00')).toBe('"\ud83d\ude00"');
		expect((0, eval)(stringify_string('a\ud83d\ude00b'))).toBe('a\ud83d\ude00b');
	});
});
