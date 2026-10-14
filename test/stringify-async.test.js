import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { parse, stringify, stringifyAsync, unflatten } from '../src/index.js';

const special_values = [
	{ name: 'undefined', value: undefined },
	{ name: 'NaN', value: NaN },
	{ name: 'negative zero', value: -0 },
	{ name: 'positive infinity', value: Infinity },
	{ name: 'negative infinity', value: -Infinity }
];

class Wrapped {
	constructor(value) {
		this.value = value;
	}
}

describe.each([
	{ name: 'objects', wrap: (value) => ({ value }) },
	{ name: 'arrays', wrap: (value) => [value] },
	{ name: 'Sets', wrap: (value) => new Set([value]) },
	{ name: 'Map keys', wrap: (value) => new Map([[value, 'unchanged']]) },
	{ name: 'Map values', wrap: (value) => new Map([['unchanged', value]]) },
	{
		name: 'null-prototype objects',
		wrap: (value) => Object.assign(Object.create(null), { value })
	},
	{
		name: 'sparse arrays',
		wrap: (value) => {
			const array = Array(1000);
			array[999] = value;
			return array;
		}
	},
	{
		name: 'custom reducer payloads',
		wrap: (value) => new Wrapped(value),
		reducers: { Wrapped: (value) => value instanceof Wrapped && [value.value] },
		revivers: { Wrapped: ([value]) => new Wrapped(value) }
	}
])('stringifyAsync: special values in $name', ({ wrap, reducers, revivers }) => {
	test.each(special_values)('resolves $name', async ({ value }) => {
		const expected = wrap(value);
		const serialized = await stringifyAsync(wrap(Promise.resolve(value)), reducers);

		expect(parse(serialized, revivers)).toEqual(expected);
		expect(unflatten(JSON.parse(serialized), revivers)).toEqual(expected);
	});
});

describe('stringifyAsync: resolved references', () => {
	test.each(special_values)('resolves repeated promises of $name', async ({ value }) => {
		const promise = Promise.resolve(value);
		const serialized = await stringifyAsync({ value: promise, array: [promise, promise] });
		const expected = { value, array: [value, value] };

		expect(serialized).toEqual(stringify(expected));
		expect(parse(serialized)).toEqual(expected);
	});

	test('resolves special values discovered inside a resolved promise', async () => {
		const serialized = await stringifyAsync({
			value: Promise.resolve({ nested: Promise.resolve(-Infinity) })
		});
		const expected = { value: { nested: -Infinity } };

		expect(serialized).toEqual(stringify(expected));
		expect(parse(serialized)).toEqual(expected);
	});

	test('preserves ordinary negative numbers and strings containing reference-like text', async () => {
		const expected = {
			'\u0000-1\u0000': '\u00001\u0000',
			values: [-1, -3, -4, -5, -6],
			value: undefined
		};
		const serialized = await stringifyAsync({ ...expected, value: Promise.resolve(undefined) });

		expect(serialized).toEqual(stringify(expected));
		expect(parse(serialized)).toEqual(expected);
	});

	test('deduplicates promises resolving to an existing value', async () => {
		const value = { nested: true };
		const serialized = await stringifyAsync([value, Promise.resolve(value)]);
		const parsed = parse(serialized);

		expect(serialized).toEqual(stringify([value, value]));
		expect(parsed[0]).toBe(parsed[1]);
	});

	test('preserves typed-array offsets when resolved promises remove reference slots', async () => {
		const buffer = new Uint8Array([0, 1, 2, 3]).buffer;
		const view = new Uint8Array(buffer, 1, 2);
		const expected = { value: undefined, view };
		const serialized = await stringifyAsync({ value: Promise.resolve(undefined), view });
		const parsed = parse(serialized);

		expect(serialized).toEqual(stringify(expected));
		expect(parsed).toEqual(expected);
		expect(parsed.view.byteOffset).toBe(1);
		expect(parsed.view.buffer.byteLength).toBe(4);
	});

	test('preserves custom reducer names containing quotes and reference-like text', async () => {
		const key = 'Type"\u00001\u0000';
		const reducers = { [key]: (value) => value instanceof Wrapped && [value.value] };
		const revivers = { [key]: ([value]) => new Wrapped(value) };
		const expected = new Wrapped(undefined);
		const sync = stringify(expected, reducers);
		const async = await stringifyAsync(new Wrapped(Promise.resolve(undefined)), reducers);

		expect(async).toEqual(sync);
		expect(parse(sync, revivers)).toEqual(expected);
		expect(parse(async, revivers)).toEqual(expected);
	});
});

describe('stringifyAsync: rejection handling', () => {
	// Run each regression in isolation so an unhandled internal rejection fails the
	// test without terminating the test runner or relying on its rejection handlers.
	function in_subprocess(fn) {
		execFileSync(
			process.execPath,
			[
				'--unhandled-rejections=strict',
				'--input-type=module',
				'--eval',
				`
				import assert from 'node:assert/strict';
				import { setTimeout as delay } from 'node:timers/promises';
				import { stringifyAsync } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
				await (${fn})({ assert, delay, stringifyAsync });
			`
			],
			{ timeout: 5000, stdio: 'pipe' }
		);
	}

	test('handles a later promise rejecting before an earlier one resolves', () => {
		in_subprocess(async ({ assert, delay, stringifyAsync }) => {
			const error = new Error('fetch failed');
			try {
				await stringifyAsync({ slow: delay(50, 42), failing: Promise.reject(error) });
				assert.fail('should have thrown');
			} catch (e) {
				assert.strictEqual(e, error);
			}
		});
	});

	test('handles promises discovered while resolving another promise', () => {
		in_subprocess(async ({ assert, delay, stringifyAsync }) => {
			const error = new Error('nested failure');
			try {
				await stringifyAsync({
					slow: delay(50, 42),
					nested: Promise.resolve().then(() => ({ failing: Promise.reject(error) }))
				});
				assert.fail('should have thrown');
			} catch (e) {
				assert.strictEqual(e, error);
			}
		});
	});

	test('handles remaining rejections after the returned promise rejects', () => {
		in_subprocess(async ({ assert, delay, stringifyAsync }) => {
			const error = new Error('first failure');
			try {
				await stringifyAsync({
					first: Promise.reject(error),
					later: delay(10).then(() => {
						throw new Error('later failure');
					}),
					nested: delay(20).then(() => ({ failing: Promise.reject(new Error('nested failure')) }))
				});
				assert.fail('should have thrown');
			} catch (e) {
				assert.strictEqual(e, error);
			}
			await delay(50);
		});
	});

	test('handles pending rejections when synchronous traversal throws', () => {
		in_subprocess(async ({ assert, delay, stringifyAsync }) => {
			try {
				await stringifyAsync({
					failing: Promise.reject(new Error('fetch failed')),
					invalid: () => {}
				});
				assert.fail('should have thrown');
			} catch (e) {
				assert.strictEqual(e.name, 'DevalueError');
				assert.strictEqual(e.message, 'Cannot stringify a function');
			}
			await delay(50);
		});
	});

	test('handles serialization errors in a later resolved promise', () => {
		in_subprocess(async ({ assert, delay, stringifyAsync }) => {
			try {
				await stringifyAsync({ slow: delay(50, 42), invalid: Promise.resolve(() => {}) });
				assert.fail('should have thrown');
			} catch (e) {
				assert.strictEqual(e.name, 'DevalueError');
				assert.strictEqual(e.message, 'Cannot stringify a function');
			}
		});
	});

	test('handles rejected thenables', () => {
		in_subprocess(async ({ assert, delay, stringifyAsync }) => {
			const error = new Error('thenable failure');
			try {
				await stringifyAsync({
					slow: delay(50, 42),
					failing: { then: (resolve, reject) => reject(error) }
				});
				assert.fail('should have thrown');
			} catch (e) {
				assert.strictEqual(e, error);
			}
		});
	});
});
