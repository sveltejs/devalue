import { setImmediate as turn } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { parse, stringify, uneval, unevalStream } from '../src/index.js';
import { client } from './helpers/stream.js';

const primitives = [
	{ kind: 'string', make: (n) => 'x'.repeat(n * 8) },
	{ kind: 'escaped string', make: (n) => '</script>\n"\\\0\u2028\u2029'.repeat(n) },
	{ kind: 'bigint', make: (n) => BigInt('9'.repeat(n * 4)) }
];

test.each(
	['batch', 'separate'].flatMap((mode) => primitives.map((primitive) => ({ mode, ...primitive })))
)('$mode: repeated $kind settlements grow linearly', async ({ mode, make }) => {
	const sizes = [];
	for (const n of [128, 256]) {
		const primitive = make(n);
		const encoded = stringify(Array(n).fill(primitive));
		const values = parse(encoded);
		const controlled = mode === 'separate' ? values.map(() => Promise.withResolvers()) : [];
		// These are distinct native promises, not repeated references to one promise.
		const promises = values.map((value, i) =>
			mode === 'separate' ? controlled[i].promise : Promise.resolve(value)
		);
		expect(new Set(promises).size).toBe(n);
		const stream = unevalStream(promises);
		const c = client();
		const root = c.head(stream.head);
		let source = stream.head;
		const consuming = (async () => {
			for await (const block of stream.tail) {
				source += block;
				c.block(block);
			}
		})();
		if (mode === 'separate') {
			for (let i = 0; i < n; i += 1) {
				controlled[i].resolve(values[i]);
				await turn();
			}
		}
		await consuming;

		expect(root).toHaveLength(n);
		expect(new Set(root).size).toBe(n);
		for (const revived of await Promise.all(root)) expect(revived).toBe(primitive);
		sizes.push({ n, input: encoded.length, output: source.length });
	}

	// All VM values are verified before checking budgets; do not prescribe batching.
	expect
		.soft(sizes[1].output / sizes[0].output, 'doubling the input must not quadruple output')
		.toBeLessThan(2.5);
	for (const { n, input, output } of sizes) {
		expect
			.soft(output, `n=${n}: output exceeds the linear input budget`)
			.toBeLessThan(input * 8 + n * 192 + 4096);
	}
});

test('control: primitive interning preserves custom cycles across discarded renderings', async () => {
	class Cyclic {
		constructor(text, meta) {
			this.text = text;
			this.meta = meta;
		}
	}
	const text = '</script>\n"\\\0\u2028\u2029'.repeat(128);
	const value = new Cyclic(text, {});
	value.meta.parent = value;
	const first = Promise.withResolvers();
	const second = Promise.withResolvers();
	const stream = unevalStream({ first: first.promise, second: second.promise }, (v, js) =>
		v instanceof Cyclic ? js`new Cyclic(${v.text},${v.meta})` : undefined
	);
	const c = client({ Cyclic });
	const root = c.head(stream.head);

	// Rendering text before meta's cycle can discard an outer constructor rendering.
	// Its primitive-slot assignment must not be mistaken for an emitted assignment.
	first.resolve(value);
	c.block((await stream.tail.next()).value);
	const revived = await root.first;
	expect(revived).toBeInstanceOf(Cyclic);
	expect(revived.text).toBe(text);
	expect(revived.meta.parent).toBe(revived);
	expect(revived.meta.parent.meta).toBe(revived.meta);

	second.resolve(text);
	for await (const block of stream.tail) c.block(block);
	expect(await root.second).toBe(text);
});

test('control: a failed emission does not poison a later settlement of the same primitive', async () => {
	const text = '</script>\n"\\\0\u2028\u2029'.repeat(128);
	const first = Promise.withResolvers();
	const second = Promise.withResolvers();
	const stream = unevalStream({ first: first.promise, second: second.promise });
	const c = client();
	const root = c.head(stream.head);

	// The eligible primitive is encountered before the unsupported late field.
	first.resolve({ text, unsupported: Symbol('unsupported late property') });
	c.block((await stream.tail.next()).value);
	await expect(root.first).rejects.toThrow('devalue: failed to serialize asynchronous value');
	second.resolve(text);
	for await (const block of stream.tail) c.block(block);
	expect(await root.second).toBe(text);
});

test('a rendering failure discards staged primitives without losing earlier committed slots', async () => {
	const committed = 'committed'.repeat(128);
	const staged = 'staged'.repeat(128);
	const first = Promise.withResolvers();
	const second = Promise.withResolvers();
	const stream = unevalStream({ committed, first: first.promise, second: second.promise });
	const c = client();
	const root = c.head(stream.head);
	let reads = 0;
	first.resolve({
		staged,
		get late() {
			if (++reads > 1) throw new Error('failure after primitive rendering');
			return null;
		}
	});
	c.block((await stream.tail.next()).value);
	expect(reads).toBe(2);
	await expect(root.first).rejects.toThrow('devalue: failed to serialize asynchronous value');
	second.resolve({ committed, staged });
	for await (const block of stream.tail) c.block(block);
	expect(await root.second).toEqual({ committed, staged });
});

test.each(primitives)('head $kind slots are reused by tails', async ({ make }) => {
	const primitive = make(128);
	const deferred = Promise.withResolvers();
	// Repetition exercises local primitive declarations as well as direct renders.
	const stream = unevalStream({ values: [primitive, primitive], later: deferred.promise });
	const c = client();
	const root = c.head(stream.head);
	expect(root.values).toEqual([primitive, primitive]);
	deferred.resolve(primitive);
	let source = '';
	for await (const block of stream.tail) {
		source += block;
		c.block(block);
	}
	expect(await root.later).toBe(primitive);
	expect(source.length).toBeLessThan(primitive.toString().length / 2);
});

test('short strings and inexpensive bigints do not acquire primitive slots', async () => {
	const short = '\n'.repeat(127); // Eligibility uses string length, not escaped length.
	const bigint = BigInt('9'.repeat(126)); // 127 characters including the n suffix.
	const deferred = Promise.withResolvers();
	const stream = unevalStream({ short, bigint, later: deferred.promise });
	const c = client();
	const root = c.head(stream.head);
	const session = c.context.__d[stream.id];
	expect(
		session.o.filter((value) => typeof value === 'string' || typeof value === 'bigint')
	).toEqual([]);
	deferred.resolve({ short, bigint });
	for await (const block of stream.tail) c.block(block);
	expect(await root.later).toEqual({ short, bigint });
	expect(
		session.o.filter((value) => typeof value === 'string' || typeof value === 'bigint')
	).toEqual([]);
});

test.each(primitives)('a no-promise $kind head preserves standalone output', async ({ make }) => {
	const primitive = make(128);
	const value = { primitive, repeated: [primitive, primitive] };
	const stream = unevalStream(value);
	expect(stream.head).toBe(uneval(value));
	const c = client();
	expect(c.head(stream.head)).toEqual(value);
	expect(c.context.__d).toBeUndefined();
	expect(await stream.tail.next()).toEqual({ done: true, value: undefined });
});

test('primitive initialization composes with reference aliases and alternate slot bindings', async () => {
	const key = 'path'.repeat(20);
	const nodes = Array.from({ length: 32 }, (_, i) => ({ i }));
	const text = 'primitive'.repeat(128);
	const first = Promise.withResolvers();
	const second = Promise.withResolvers();
	const stream = unevalStream({ [key]: nodes, first: first.promise, second: second.promise });
	const c = client();
	const root = c.head(stream.head);
	first.resolve({ refs: nodes.slice(), values: [text, text] });
	c.block((await stream.tail.next()).value);
	const revived = await root.first;
	expect(revived.values).toEqual([text, text]);
	for (let i = 0; i < nodes.length; i += 1) expect(revived.refs[i]).toBe(root[key][i]);
	second.resolve({ refs: nodes.slice(), text });
	for await (const block of stream.tail) c.block(block);
	const reused = await root.second;
	expect(reused.text).toBe(text);
	for (let i = 0; i < nodes.length; i += 1) expect(reused.refs[i]).toBe(revived.refs[i]);
});
