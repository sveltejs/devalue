import { expect, test } from 'vitest';
import { parse, stringify, unevalStream } from '../src/index.js';
import { client, expect_roundtrip } from './helpers/stream.js';

/** @param {string} source */
function utf8_transport(source) {
	const bytes = new TextEncoder().encode(source);
	const decoder = new TextDecoder();
	let reconstructed = '';
	for (const byte of bytes) reconstructed += decoder.decode(Uint8Array.of(byte), { stream: true });
	return reconstructed + decoder.decode();
}

test('survives UTF-8 byte boundaries and separate or concatenated VM evaluation', async () => {
	const resolved = Promise.withResolvers();
	const failed = Promise.withResolvers();
	const shared = { label: 'shared-😀' };
	const reason = 'late </script> rejection 😀 \udfff';
	const id = 'transport-001-😀-</script>-\ud800';
	const value = {
		numeric: { 0: '0', 12: '12', '001': '001' },
		lone: '\ud800',
		pair: '😀',
		closing: '</script><script>data</script>',
		shared,
		resolved: resolved.promise,
		rejected: failed.promise
	};
	const result = unevalStream(value, undefined, { id, transformError: (error) => error });
	expect(result.id).toBe(id);
	resolved.resolve({ shared, again: shared });
	const sources = [result.head, /** @type {string} */ ((await result.tail.next()).value)];
	failed.reject(reason);
	for await (const block of result.tail) sources.push(block);
	expect(sources.length).toBe(3);
	for (const source of sources) expect(utf8_transport(source)).toBe(source);
	expect(sources.join('')).not.toMatch(/<\/script/i);

	/** @param {any} root */
	async function verify(root) {
		expect(Object.keys(root.numeric)).toEqual(['0', '12', '001']);
		expect(root.lone).toBe('\ud800');
		expect(root.pair).toBe('😀');
		expect(root.closing).toBe(value.closing);
		const outcome = await root.resolved;
		expect(outcome.shared).toBe(root.shared);
		expect(outcome.again).toBe(root.shared);
		await expect(root.rejected).rejects.toBe(reason);
	}

	const [head, ...blocks] = sources.map(utf8_transport);
	const separate = client();
	const root = separate.head(head);
	for (const block of blocks) separate.block(block);
	await verify(root);
	await verify(client().combined(head, blocks));
});

/**
 * @param {unknown} value
 * @param {'head' | 'tail'} mode
 * @param {import('../src/types.js').UnevalReplacer} [replacer]
 * @param {Record<string, unknown>} [globals]
 */
async function roundtrip(value, mode, replacer, globals) {
	const { head, blocks, root } = await expect_roundtrip(
		({ later }) => (mode === 'head' ? value : later(value)),
		{ replacer, globals, orders: ['fifo'] }
	);
	return { restored: mode === 'head' ? root : await root, source: head + blocks.join('') };
}

class Box {
	/** @param {unknown} value */
	constructor(value) {
		this.value = value;
	}
}

test.each(
	['head', 'tail'].flatMap((mode) =>
		[
			{ kind: 'string', make: (/** @type {number} */ n) => 'x'.repeat(n) },
			{
				kind: 'escaped string',
				make: (/** @type {number} */ n) => '</script>\n"\\\0\u2028\u2029'.repeat(n)
			},
			{ kind: 'bigint', make: (/** @type {number} */ n) => BigInt('9'.repeat(n)) }
		].map((row) => ({ mode: /** @type {'head' | 'tail'} */ (mode), ...row }))
	)
)('$mode: repeated $kind output grows linearly', async ({ mode, make }) => {
	let previous = 0;
	for (const n of [2000, 4000]) {
		const encoded = stringify(Array(n).fill(make(n)));
		const { source } = await roundtrip(parse(encoded), mode);
		expect(source.length).toBeLessThan(encoded.length * 4);
		if (previous) expect(source.length).toBeLessThan(previous * 2.1);
		previous = source.length;
		expect(source).not.toContain('<');
	}
});

test.each(
	['head', 'tail'].flatMap((mode) =>
		['inline', 'shared', 'cyclic', 'holes', 'custom-cycle'].map((kind) => ({
			mode: /** @type {'head' | 'tail'} */ (mode),
			kind
		}))
	)
)('$mode: $kind sparse arrays avoid eager allocation', async ({ mode, kind }) => {
	// eager allocation would need ~20GB; parse creates dictionary-mode arrays
	const length = 1_000_000;
	const arrays = Array.from({ length: 2500 }, () => parse(`[[-7,${length},0,1],42]`));
	for (const array of arrays) {
		if (kind === 'holes') delete array[0];
		else
			array[1] = kind === 'cyclic' ? array : kind === 'custom-cycle' ? new Box(array) : undefined;
	}
	const value = kind === 'shared' ? [arrays, arrays.slice()] : arrays;
	const { restored } = await roundtrip(
		value,
		mode,
		(v, js) => (v instanceof Box ? js`new Box(${v.value})` : undefined),
		{ Box }
	);
	const result = kind === 'shared' ? restored[0] : restored;
	for (const i of [0, arrays.length - 1]) {
		expect(result[i].length).toBe(length);
		expect(Object.getOwnPropertyNames(result[i])).toEqual(
			kind === 'holes' ? ['length'] : ['0', '1', 'length']
		);
	}
});

test.each([{ mode: /** @type {const} */ ('head') }, { mode: /** @type {const} */ ('tail') }])(
	'$mode: Buffers preserve identity without exposing their shared pool',
	async ({ mode }) => {
		const allocation = Buffer.allocUnsafe(128).fill(255);
		const first = allocation.subarray(8, 11);
		const second = allocation.subarray(24, 26);
		first.set([1, 2, 3]);
		second.set([4, 5]);
		/** @type {Record<string, unknown>} */
		const value = { first, again: first, second };
		value.self = value;
		const { restored, source } = await roundtrip(value, mode);
		expect(restored.first.buffer.byteLength).toBe(3);
		expect(restored.second.buffer.byteLength).toBe(2);
		expect(restored.first.buffer).not.toBe(restored.second.buffer);
		expect(source).not.toContain('255');
	}
);
