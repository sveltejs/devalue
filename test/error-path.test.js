import { describe, expect, test } from 'vitest';
import { DevalueError, stringify, stringifyAsync, uneval } from '../src/index.js';

/**
 * @param {(value: any) => any} fn
 * @param {any} value
 */
async function capture(fn, value) {
	try {
		await fn(value);
	} catch (error) {
		return error;
	}
	throw new Error('expected a DevalueError');
}

describe.each([
	{ name: 'stringify', fn: stringify },
	{ name: 'stringifyAsync', fn: stringifyAsync },
	{ name: 'uneval', fn: uneval }
])('$name error paths', ({ fn }) => {
	test('reports sparse array indices and quoted keys', async () => {
		const invalid = () => {};
		const array = [];
		array[1000000] = { 0: { 'odd.key': invalid } };
		const root = { array };

		const error = await capture(fn, root);
		expect(error).toBeInstanceOf(DevalueError);
		expect(error.path).toBe('.array[1000000]["0"]["odd.key"]');
		expect(error.value).toBe(invalid);
		expect(error.root).toBe(root);
	});

	test('formats primitive and object Map keys', async () => {
		const invalid = () => {};
		const inner = new Map([[null, [invalid]]]);
		const root = new Map([
			['fine', 1],
			[42, new Map([[{ id: 1 }, inner]])]
		]);

		const error = await capture(fn, root);
		expect(error).toBeInstanceOf(DevalueError);
		expect(error.path).toBe('.get(42).get(...).get(null)[0]');
		expect(error.value).toBe(invalid);
		expect(error.root).toBe(root);
	});

	test('drops Map entries from the path once they are serialized', async () => {
		const invalid = () => {};
		const root = {
			map: new Map([['key', new Map([['nested', 1]])]]),
			later: { invalid }
		};

		const error = await capture(fn, root);
		expect(error).toBeInstanceOf(DevalueError);
		expect(error.path).toBe('.later.invalid');
	});
});

test('DevalueError joins the path segments it is given', () => {
	const value = () => {};
	const root = { array: [value] };
	const error = new DevalueError('invalid', ['.array', '[0]', '.get("key")'], value, root);

	expect(error.path).toBe('.array[0].get("key")');
	expect(error.value).toBe(value);
	expect(error.root).toBe(root);
});
