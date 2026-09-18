import * as uvu from 'uvu';
import * as assert from 'uvu/assert';
import { DevalueError, stringify, stringifyAsync, uneval } from '../index.js';

for (const fn of [stringify, stringifyAsync, uneval]) {
	uvu.test(`${fn.name} reports sparse array indices and quoted keys in error.path`, async () => {
		const invalid = () => {};
		const array = [];
		array[1000000] = { 0: { 'odd.key': invalid } };
		const root = { array };

		try {
			await fn(root);
			assert.unreachable('should have thrown');
		} catch (error) {
			assert.instance(error, DevalueError);
			assert.is(error.path, '.array[1000000]["0"]["odd.key"]');
			assert.is(error.value, invalid);
			assert.is(error.root, root);
		}
	});

	uvu.test(`${fn.name} formats primitive and object Map keys in error.path`, async () => {
		const invalid = () => {};
		const inner = new Map([[null, [invalid]]]);
		const root = new Map([
			['fine', 1],
			[42, new Map([[{ id: 1 }, inner]])]
		]);

		try {
			await fn(root);
			assert.unreachable('should have thrown');
		} catch (error) {
			assert.instance(error, DevalueError);
			assert.is(error.path, '.get(42).get(...).get(null)[0]');
			assert.is(error.value, invalid);
			assert.is(error.root, root);
		}
	});

	uvu.test(`${fn.name} drops Map entries from error.path once they are serialized`, async () => {
		const invalid = () => {};
		const root = {
			map: new Map([['key', new Map([['nested', 1]])]]),
			later: { invalid }
		};

		try {
			await fn(root);
			assert.unreachable('should have thrown');
		} catch (error) {
			assert.instance(error, DevalueError);
			assert.is(error.path, '.later.invalid');
		}
	});
}

uvu.test('DevalueError joins the path segments it is given', () => {
	const value = () => {};
	const root = { array: [value] };
	const error = new DevalueError('invalid', ['.array', '[0]', '.get("key")'], value, root);

	assert.is(error.path, '.array[0].get("key")');
	assert.is(error.value, value);
	assert.is(error.root, root);
});

uvu.test.run();
