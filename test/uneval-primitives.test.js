import * as assert from 'uvu/assert';
import { suite } from 'uvu';
import { parse, stringify, uneval } from '../index.js';

const test = suite('uneval: repeated primitives');

for (const [name, make_primitive] of [
	['string', (n) => 'x'.repeat(n)],
	['escaped string', (n) => '</script>\n"\\\0\u2028\u2029'.repeat(n)],
	['bigint', (n) => BigInt('9'.repeat(n))]
]) {
	test(`${name} output grows linearly when reserializing compact input`, () => {
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

			assert.equal((0, eval)(serialized), value);
			assert.not.ok(serialized.includes('<'));
		}
	});

	test(`${name} shared by distinct boxes stays compact`, () => {
		const primitive = make_primitive(2000);
		const encoded = stringify(Array.from({ length: 2000 }, () => Object(primitive)));
		const serialized = uneval(parse(encoded));

		assert.ok(serialized.length < encoded.length * 4);
		const result = (0, eval)(serialized);
		assert.is(result.length, 2000);
		assert.is(new Set(result).size, 2000);
		for (const box of result) {
			assert.type(box, 'object');
			assert.is(box.valueOf(), primitive);
		}
	});

	test(`${name} preserves shared and distinct box identities`, () => {
		const primitive = make_primitive(256);
		const box = Object(primitive);
		const value = [box, box, primitive, primitive, Object(primitive)];
		const result = (0, eval)(uneval(value));

		assert.is(result[0], result[1]);
		assert.is(result[0].valueOf(), primitive);
		assert.is(result[2], primitive);
		assert.is(result[3], primitive);
		assert.is(result[4].valueOf(), primitive);
		assert.is(new Set([result[0], result[4]]).size, 2);
	});

	test(`${name} round-trips in shared and cyclic containers`, () => {
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
		assert.is(Object.getPrototypeOf(result), null);
		assert.is(result.self, result);
		assert.is(result.primitive, primitive);
		assert.is(result.array, result.array_again);
		assert.is(result.array[0], primitive);
		assert.is(result.map, result.map_again);
		assert.is(result.map.get(primitive), primitive);
		assert.is(result.set, result.set_again);
		assert.ok(result.set.has(primitive));
		assert.is(result.box, result.box_again);
		assert.is(result.box.valueOf(), primitive);
		assert.equal(result.sparse, sparse);
	});
}

test('keeps inexpensive repetitions inline', () => {
	assert.is(uneval(['a string', 'a string']), '["a string","a string"]');
	assert.is(uneval(['', '', 1n, 1n]), '["","",1n,1n]');
	const value = Array(1000).fill('pending');
	assert.is(uneval(value), JSON.stringify(value));
});

test('bounds expansion on both sides of the short-string cutoff', () => {
	for (const length of [127, 128, 129]) {
		for (const character of ['x', '<']) {
			const value = Array(2000).fill(character.repeat(length));
			const serialized = uneval(value);

			assert.equal((0, eval)(serialized), value);
			assert.not.ok(serialized.includes('<'));
			if (length < 128) {
				assert.ok(serialized.startsWith('['));
				assert.ok(serialized.length <= value.length * (6 * length + 3) + 1);
			} else {
				assert.ok(serialized.length < 6 * length + 3 * value.length);
			}
		}
	}
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

	assert.equal(visited, [value, box, box.value]);
	assert.is(result[0], result[1]);
	assert.ok(result[0] instanceof Box);
	assert.equal(result[0].value, [text, text]);
	assert.equal(result.slice(2), [text, text]);
});

test('supports more hoisted primitives than the function parameter limit', () => {
	const strings = Array.from({ length: 66000 }, (_, i) => String(i).padStart(128, 'x'));
	const value = [strings, strings.slice()];
	const serialized = uneval(value);

	assert.ok(serialized.length < JSON.stringify(value).length);
	assert.equal((0, eval)(serialized), value);
});

test.run();
