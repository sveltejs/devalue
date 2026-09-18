import { execFileSync } from 'node:child_process';
import * as uvu from 'uvu';

const test = uvu.suite('stringifyAsync: rejection handling');

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
				import * as assert from 'uvu/assert';
				import { setTimeout as delay } from 'node:timers/promises';
				import { stringifyAsync } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
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
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.is(e, error);
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
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.is(e, error);
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
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.is(e, error);
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
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.is(e.name, 'DevalueError');
			assert.is(e.message, 'Cannot stringify a function');
		}
		await delay(50);
	});
});

test('handles serialization errors in a later resolved promise', () => {
	in_subprocess(async ({ assert, delay, stringifyAsync }) => {
		try {
			await stringifyAsync({ slow: delay(50, 42), invalid: Promise.resolve(() => {}) });
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.is(e.name, 'DevalueError');
			assert.is(e.message, 'Cannot stringify a function');
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
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.is(e, error);
		}
	});
});

test.run();
