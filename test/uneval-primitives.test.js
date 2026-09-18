import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parse, stringify, uneval } from '../index.js';

describe('uneval: repeated primitives', () => {
	describe.each([
		['string', (n) => 'x'.repeat(n)],
		['escaped string', (n) => '</script>\n"\\\0\u2028\u2029'.repeat(n)],
		['bigint', (n) => BigInt('9'.repeat(n))]
	])('%s', (_name, make_primitive) => {
		test('output grows linearly when reserializing compact input', () => {
			let previous_length = 0;

			for (const n of [2000, 4000]) {
				const primitive = make_primitive(n);
				const encoded = JSON.stringify([
					Array(n).fill(1),
					typeof primitive === 'bigint' ? ['BigInt', String(primitive)] : primitive
				]);
				const value = parse(encoded);
				const serialized = uneval(value);

				assert.ok(serialized.length < encoded.length * 4);
				if (previous_length) assert.ok(serialized.length < previous_length * 2.1);
				previous_length = serialized.length;

				assert.deepStrictEqual((0, eval)(serialized), value);
				assert.ok(!serialized.includes('<'));
			}
		});

		test('shared by distinct boxes stays compact', () => {
			const primitive = make_primitive(2000);
			const encoded = stringify(Array.from({ length: 2000 }, () => Object(primitive)));
			const serialized = uneval(parse(encoded));

			assert.ok(serialized.length < encoded.length * 4);
			const result = (0, eval)(serialized);
			assert.strictEqual(result.length, 2000);
			assert.strictEqual(new Set(result).size, 2000);
			for (const box of result) {
				assert.strictEqual(typeof box, 'object');
				assert.strictEqual(box.valueOf(), primitive);
			}
		});

		test('preserves shared and distinct box identities', () => {
			const primitive = make_primitive(256);
			const box = Object(primitive);
			const value = [box, box, primitive, primitive, Object(primitive)];
			const result = (0, eval)(uneval(value));

			assert.strictEqual(result[0], result[1]);
			assert.strictEqual(result[0].valueOf(), primitive);
			assert.strictEqual(result[2], primitive);
			assert.strictEqual(result[3], primitive);
			assert.strictEqual(result[4].valueOf(), primitive);
			assert.strictEqual(new Set([result[0], result[4]]).size, 2);
		});

		test('round-trips in shared and cyclic containers', () => {
			const primitive = make_primitive(256);
			const array = [primitive];
			const map = new Map([[primitive, primitive]]);
			const set = new Set([primitive]);
			const box = Object(primitive);
			const sparse = [];
			sparse[1000] = primitive;
			const value = Object.assign(Object.create(null), {
				primitive,
				array,
				array_again: array,
				map,
				map_again: map,
				set,
				set_again: set,
				box,
				box_again: box,
				sparse
			});
			value.self = value;

			const result = (0, eval)(uneval(value));
			assert.strictEqual(Object.getPrototypeOf(result), null);
			assert.strictEqual(result.self, result);
			assert.strictEqual(result.primitive, primitive);
			assert.strictEqual(result.array, result.array_again);
			assert.strictEqual(result.array[0], primitive);
			assert.strictEqual(result.map, result.map_again);
			assert.strictEqual(result.map.get(primitive), primitive);
			assert.strictEqual(result.set, result.set_again);
			assert.ok(result.set.has(primitive));
			assert.strictEqual(result.box, result.box_again);
			assert.strictEqual(result.box.valueOf(), primitive);
			assert.deepStrictEqual(result.sparse, sparse);
		});
	});

	test('keeps inexpensive repetitions inline', () => {
		assert.strictEqual(uneval(['a string', 'a string']), '["a string","a string"]');
		assert.strictEqual(uneval(['', '', 1n, 1n]), '["","",1n,1n]');
		const value = Array(1000).fill('pending');
		assert.strictEqual(uneval(value), JSON.stringify(value));
	});

	describe.each([127, 128, 129])('short-string cutoff (length=%i)', (length) => {
		test.each(['x', '<'])('bounds expansion (character=%s)', (character) => {
			const value = Array(2000).fill(character.repeat(length));
			const serialized = uneval(value);

			assert.deepStrictEqual((0, eval)(serialized), value);
			assert.ok(!serialized.includes('<'));
			if (length < 128) {
				assert.ok(serialized.startsWith('['));
				assert.ok(serialized.length <= value.length * (6 * length + 3) + 1);
			} else {
				assert.ok(serialized.length < 6 * length + 3 * value.length);
			}
		});
	});

	test('preserves other primitives alongside hoisted values', () => {
		const text = 'x'.repeat(256);
		const value = [
			text,
			text,
			0,
			-0,
			0,
			-0,
			NaN,
			NaN,
			Infinity,
			-Infinity,
			undefined,
			null,
			true,
			false
		];
		const result = (0, eval)(uneval(value));

		for (let i = 0; i < value.length; i += 1) {
			assert.ok(Object.is(result[i], value[i]));
		}
	});

	test('preserves replacer behavior and recursive uneval scopes', () => {
		class Box {
			constructor(value) {
				this.value = value;
			}
		}

		const text = 'x'.repeat(256);
		const box = new Box([text, text]);
		const value = [box, box, text, text];
		const visited = [];
		const serialized = uneval(value, (value, js) => {
			visited.push(value);
			if (value instanceof Box) return js`new Box(${value.value})`;
		});
		const result = new Function('Box', `return ${serialized}`)(Box);

		assert.deepStrictEqual(visited, [value, box, box.value]);
		assert.strictEqual(result[0], result[1]);
		assert.ok(result[0] instanceof Box);
		assert.deepStrictEqual(result[0].value, [text, text]);
		assert.deepStrictEqual(result.slice(2), [text, text]);
	});

	test('supports more hoisted primitives than the function parameter limit', () => {
		const strings = Array.from({ length: 66000 }, (_, i) => String(i).padStart(128, 'x'));
		const value = [strings, strings.slice()];
		const serialized = uneval(value);

		assert.ok(serialized.length < JSON.stringify(value).length);
		assert.deepStrictEqual((0, eval)(serialized), value);
	});
});
