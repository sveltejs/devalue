import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parse, stringify, stringifyAsync, uneval } from '../index.js';

const serializers = [
	[uneval, (source) => (0, eval)(`(${source})`)],
	[stringify, parse],
	[stringifyAsync, parse]
];

const sources = {
	'Buffer.from': () => Buffer.from([1, 2, 3]),
	'Buffer.allocUnsafe': () => {
		const buffer = Buffer.allocUnsafe(3);
		buffer.set([1, 2, 3]);
		return buffer;
	},
	'Buffer.concat': () => Buffer.concat([Buffer.from([1]), Buffer.from([2, 3])]),
	'Buffer.slice': () => Buffer.from([255, 1, 2, 3, 255]).slice(1, 4),
	'Buffer.subarray': () => Buffer.from([255, 1, 2, 3, 255]).subarray(1, 4),
	'unpooled Buffer subarray': () => {
		const buffer = Buffer.alloc(32, 255);
		buffer.set([1, 2, 3], 8);
		return buffer.subarray(8, 11);
	},
	'Buffer over an ArrayBuffer': () => Buffer.from(new Uint8Array([255, 1, 2, 3, 255]).buffer, 1, 3),
	'Buffer from a vm context': () => runInNewContext('Buffer.from([1, 2, 3])', { Buffer })
};

describe.each(serializers.map(([serialize, deserialize]) => ({ serialize, deserialize })))(
	'$serialize.name: Node Buffer',
	({ serialize, deserialize }) => {
		test.each(Object.entries(sources))(
			'only serializes the visible bytes of %s',
			async (_name, create) => {
				const value = create();
				assert.ok(value.buffer.byteLength > value.byteLength);

				const serialized = await serialize(value);
				assert.strictEqual(
					serialized,
					serialize === uneval
						? 'new Uint8Array([1,2,3])'
						: '[["Uint8Array",1],["ArrayBuffer","AQID"]]'
				);

				const result = deserialize(serialized);
				assert.deepStrictEqual(result, new Uint8Array([1, 2, 3]));
				assert.strictEqual(result.byteOffset, 0);
				assert.strictEqual(result.buffer.byteLength, 3);
			}
		);

		test('does not serialize backing bytes for an empty subarray', async () => {
			const value = Buffer.from('SECRET').subarray(3, 3);
			const serialized = await serialize(value);
			assert.strictEqual(
				serialized,
				serialize === uneval ? 'new Uint8Array([])' : '[["Uint8Array",1],["ArrayBuffer",""]]'
			);
			assert.strictEqual(deserialize(serialized).buffer.byteLength, 0);
		});

		test('isolates Buffers sharing a pool while preserving repeated references and cycles', async () => {
			// Use one allocation so the shared backing store is deterministic, even
			// when Node's current pool is almost exhausted.
			const allocation = Buffer.allocUnsafe(128).fill(255);
			const first = allocation.subarray(8, 11);
			const second = allocation.subarray(24, 26);
			first.set([1, 2, 3]);
			second.set([4, 5]);
			assert.strictEqual(first.buffer, second.buffer);

			const value = { first, again: first, second };
			value.self = value;

			const copy = new Uint8Array([1, 2, 3]);
			const expected = { first: copy, again: copy, second: new Uint8Array([4, 5]) };
			expected.self = expected;

			const serialized = await serialize(value);
			// Check the output too: uneval must not emit an unused copy of the pool.
			assert.strictEqual(serialized, await serialize(expected));

			const result = deserialize(serialized);
			assert.strictEqual(result.first, result.again);
			assert.strictEqual(result.self, result);
			assert.strictEqual(result.first.buffer.byteLength, 3);
			assert.strictEqual(result.second.buffer.byteLength, 2);
			assert.notStrictEqual(result.first.buffer, result.second.buffer);
		});

		test('only serializes file contents from readFileSync', async () => {
			const value = readFileSync(new URL('../package.json', import.meta.url));
			const serialized = await serialize({ file: value });
			assert.strictEqual(
				serialized,
				serialize === uneval
					? `{file:new Uint8Array([${Array.from(value)}])}`
					: `[{"file":1},["Uint8Array",2],["ArrayBuffer","${value.toString('base64')}"]]`
			);
			assert.strictEqual(deserialize(serialized).file.buffer.byteLength, value.byteLength);
		});

		test('preserves shared backing stores for ordinary typed arrays and DataViews', async () => {
			const buffer = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
			const view = new Uint8Array(buffer, 1, 3);
			const data = new DataView(buffer, 2, 2);
			const result = deserialize(await serialize({ buffer, view, again: view, data }));

			assert.strictEqual(result.view, result.again);
			assert.strictEqual(result.view.buffer, result.buffer);
			assert.strictEqual(result.data.buffer, result.buffer);
			assert.strictEqual(result.view.byteOffset, 1);
			assert.strictEqual(result.view.length, 3);
			assert.strictEqual(result.data.byteOffset, 2);
			assert.strictEqual(result.data.byteLength, 2);
			assert.deepStrictEqual(new Uint8Array(result.buffer), new Uint8Array([0, 1, 2, 3, 4, 5]));
		});
	}
);

test('stringifyAsync only serializes visible Buffer bytes after resolving a promise', async () => {
	const value = Buffer.from([255, 1, 2, 3, 255]).subarray(1, 4);
	assert.strictEqual(
		await stringifyAsync({ data: Promise.resolve(value) }),
		'[{"data":1},["Uint8Array",2],["ArrayBuffer","AQID"]]'
	);
});

test('serializes typed arrays without Node globals', () => {
	// Import in a fresh process so base64 encoding also uses the browser path.
	execFileSync(process.execPath, [
		'--input-type=module',
		'--eval',
		`
			import { deepStrictEqual } from 'node:assert';
			globalThis.Buffer = undefined;
			globalThis.process = undefined;
			const { parse, stringify, stringifyAsync, uneval } = await import(
				${JSON.stringify(new URL('../index.js', import.meta.url).href)}
			);
			const value = new Uint8Array([1, 2, 3]);
			deepStrictEqual((0, eval)(uneval(value)), value);
			deepStrictEqual(parse(stringify(value)), value);
			deepStrictEqual(parse(await stringifyAsync(value)), value);
		`
	]);
});
