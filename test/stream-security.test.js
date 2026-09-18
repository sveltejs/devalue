import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, test, expect } from 'vitest';
import { parse, stringify, unevalStream } from '../index.js';
import { client, drain } from './helpers/stream.js';

// Exercise the same values in the head, a folded outcome, a tail outcome, and a
// sequence item. Every path must apply the protections before source is rendered.
async function roundtrip(value, mode = 'head', replacer, globals) {
	const pending = Promise.withResolvers();
	const input =
		mode === 'head'
			? value
			: mode === 'folded'
				? Promise.resolve(value)
				: mode === 'tail'
					? pending.promise
					: {
							async *[Symbol.asyncIterator]() {
								yield await pending.promise;
							}
						};
	const result = await unevalStream(input, replacer);
	pending.resolve(value);
	const { root, blocks, client: target } = await drain(result, client(globals));
	let restored;
	if (mode === 'sequence') {
		restored = (await root.next()).value;
		expect((await root.next()).done).toBe(true);
	} else restored = await root;
	// Tail blocks must also remain valid when concatenated as script statements.
	const combined = target.combined(result.head, blocks);
	if (mode === 'sequence') await combined.next();
	else await combined;
	return { restored, source: result.head + blocks.join(''), blocks };
}

describe('unevalStream security regressions', () => {
	for (const mode of ['head', 'folded', 'tail', 'sequence']) {
		for (const [name, make] of [
			['string', (n) => 'x'.repeat(n)],
			['escaped string', (n) => '</script>\n"\\\0\u2028\u2029'.repeat(n)],
			['bigint', (n) => BigInt('9'.repeat(n))]
		]) {
			test(`${mode}: repeated ${name} output grows linearly`, async () => {
				let previous = 0;
				for (const n of [2000, 4000]) {
					const primitive = make(n);
					const encoded = stringify(Array(n).fill(primitive));
					const value = parse(encoded);
					const { restored, source } = await roundtrip(value, mode);
					expect(source.length).toBeLessThan(encoded.length * 4);
					if (previous) expect(source.length).toBeLessThan(previous * 2.1);
					previous = source.length;
					expect(Array.from(restored)).toEqual(value);
					// The sequence runtime contains comparison operators; data must
					// still never introduce an HTML closing tag.
					expect(source.includes('</script>')).toBe(false);
					if (mode !== 'sequence') expect(source.includes('<')).toBe(false);
				}
			});

			test(`${mode}: distinct and shared ${name} boxes stay compact`, async () => {
				const primitive = make(2000);
				const box = Object(primitive);
				const boxes = Array.from({ length: 2000 }, () => Object(primitive));
				const sparse = parse('[[-7,1000000,999999,1],42]');
				sparse[999999] = primitive;
				const value = Object.assign(Object.create(null), {
					boxes,
					box,
					again: box,
					primitive,
					sparse,
					map: new Map([[primitive, primitive]]),
					set: new Set([primitive])
				});
				value.self = value;
				const { restored, source } = await roundtrip(value, mode);
				expect(source.length).toBeLessThan(stringify(value).length * 4);
				expect(Object.getPrototypeOf(restored)).toBe(null);
				expect(restored.self).toBe(restored);
				expect(restored.box).toBe(restored.again);
				expect(new Set(restored.boxes).size).toBe(2000);
				for (const box of restored.boxes) expect(box.valueOf()).toBe(primitive);
				expect(restored.box.valueOf()).toBe(primitive);
				expect(restored.primitive).toBe(primitive);
				expect(restored.map.get(primitive)).toBe(primitive);
				expect(restored.set.has(primitive)).toBe(true);
				expect(restored.sparse.length).toBe(1000000);
				expect(restored.sparse[999999]).toBe(primitive);
			});
		}

		for (const kind of ['inline', 'shared', 'cyclic', 'holes', 'custom-cycle']) {
			test(`${mode}: ${kind} sparse arrays avoid eager allocation`, async () => {
				// Eager allocation would require ~20GB. parse creates dictionary arrays.
				const length = 1_000_000;
				const arrays = Array.from({ length: 2500 }, () => parse(`[[-7,${length},0,1],42]`));
				class Box {
					constructor(value) {
						this.value = value;
					}
				}
				for (const array of arrays) {
					if (kind === 'holes') delete array[0];
					else
						array[1] =
							kind === 'cyclic' ? array : kind === 'custom-cycle' ? new Box(array) : undefined;
				}
				const value = kind === 'shared' ? [arrays, arrays.slice()] : arrays;
				const { restored } = await roundtrip(
					value,
					mode,
					(value, js) => (value instanceof Box ? js`new Box(${value.value})` : undefined),
					{ Box }
				);
				const result = kind === 'shared' ? restored[0] : restored;
				expect(result.length).toBe(arrays.length);
				for (const i of [0, arrays.length - 1]) {
					const array = result[i];
					expect(Array.isArray(array)).toBe(true);
					expect(array.length).toBe(length);
					expect(Object.getOwnPropertyNames(array)).toEqual(
						kind === 'holes' ? ['length'] : ['0', '1', 'length']
					);
					expect(length - 1 in array).toBe(false);
					if (kind !== 'holes') expect(array[0]).toBe(42);
					if (kind === 'cyclic') expect(array[1]).toBe(array);
					if (kind === 'custom-cycle') expect(array[1].value).toBe(array);
					if (kind === 'shared') expect(restored[0][i]).toBe(restored[1][i]);
				}
			});
		}

		test(`${mode}: Buffers preserve identity without exposing their shared pool`, async () => {
			const allocation = Buffer.allocUnsafe(128).fill(255);
			const first = allocation.subarray(8, 11);
			const second = allocation.subarray(24, 26);
			first.set([1, 2, 3]);
			second.set([4, 5]);
			const value = { first, again: first, second };
			value.self = value;
			const { restored, source } = await roundtrip(value, mode);
			expect(restored.first).toBe(restored.again);
			expect(restored.self).toBe(restored);
			expect(Array.from(restored.first)).toEqual([1, 2, 3]);
			expect(Array.from(restored.second)).toEqual([4, 5]);
			expect(restored.first.buffer.byteLength).toBe(3);
			expect(restored.second.buffer.byteLength).toBe(2);
			expect(restored.first.buffer).not.toBe(restored.second.buffer);
			expect(source).not.toContain('255');
		});
	}

	for (const [name, create] of Object.entries({
		'Buffer.from': () => Buffer.from([1, 2, 3]),
		'Buffer.allocUnsafe': () => Buffer.allocUnsafe(3).fill(1),
		'Buffer.concat': () => Buffer.concat([Buffer.from([1]), Buffer.from([2, 3])]),
		'Buffer.slice': () => Buffer.from([255, 1, 2, 3, 255]).slice(1, 4),
		'Buffer.subarray': () => Buffer.from([255, 1, 2, 3, 255]).subarray(1, 4),
		'unpooled Buffer': () => Buffer.alloc(32, 255).subarray(8, 11),
		'Buffer over ArrayBuffer': () => Buffer.from(new Uint8Array([255, 1, 2, 3, 255]).buffer, 1, 3),
		'cross-realm Buffer': () => runInNewContext('Buffer.from([1, 2, 3])', { Buffer }),
		'empty Buffer': () => Buffer.from('SECRET').subarray(3, 3),
		'file Buffer': () => readFileSync(new URL('../package.json', import.meta.url))
	})) {
		test(`only emits visible bytes of ${name}`, async () => {
			const value = create();
			const { restored, source } = await roundtrip(value);
			expect(restored.buffer.byteLength).toBe(value.byteLength);
			expect(restored.byteOffset).toBe(0);
			expect(Array.from(restored)).toEqual(Array.from(value));
			expect(source).toBe((await unevalStream(new Uint8Array(value))).head);
		});
	}

	for (const kind of ['empty', 'single', 'shared', 'cyclic']) {
		test(`does not scan sparse array holes (${kind})`, async () => {
			const length = 2 ** 32 - 1;
			const index = length - 1;
			const array = parse(kind === 'empty' ? `[[-7,${length}]]` : `[[-7,${length},${index},1],42]`);
			let probes = 0;
			const probe = () => expect(++probes).toBeLessThanOrEqual(100);
			const proxy = new Proxy(array, {
				get(target, key, receiver) {
					probe();
					return Reflect.get(target, key, receiver);
				},
				has(target, key) {
					probe();
					return Reflect.has(target, key);
				},
				getOwnPropertyDescriptor(target, key) {
					probe();
					return Reflect.getOwnPropertyDescriptor(target, key);
				}
			});
			if (kind === 'cyclic') array[index] = proxy;
			const { restored, source } = await roundtrip(kind === 'shared' ? [proxy, proxy] : proxy);
			const result = kind === 'shared' ? restored[0] : restored;
			expect(source.length).toBeLessThan(200);
			expect(result.length).toBe(length);
			expect(Object.keys(result)).toEqual(kind === 'empty' ? [] : [String(index)]);
			if (kind !== 'empty') expect(result[index]).toBe(kind === 'cyclic' ? result : 42);
			if (kind === 'shared') expect(restored[0]).toBe(restored[1]);
		});
	}

	test('ignores inherited and non-index array properties and preserves sparse error paths', async () => {
		for (const length of [3, 1000]) {
			const array = [42];
			array.length = length;
			const proto = Object.create(Array.prototype);
			for (const [object, keys] of [
				[proto, [1, length - 1]],
				[array, ['foo', '-1', '01', '1e0', '1.5', '4294967295', Symbol('key')]]
			]) {
				for (const key of keys)
					Object.defineProperty(object, key, {
						enumerable: true,
						get() {
							throw new Error('must not read this property');
						}
					});
			}
			Object.setPrototypeOf(array, proto);
			const { restored } = await roundtrip([array, array]);
			expect(restored[0]).toBe(restored[1]);
			expect(restored[0].length).toBe(length);
			expect(Object.keys(restored[0])).toEqual(['0']);
		}
		const array = [];
		const invalid = () => {};
		array[99_999_999] = invalid;
		const root = { array };
		await expect(unevalStream(root)).rejects.toMatchObject({
			name: 'DevalueError',
			path: '.array[99999999]',
			value: invalid,
			root
		});
	});

	test('deduplicates primitives across independent outcomes in a single block', async () => {
		const pending = Array.from({ length: 2000 }, () => Promise.withResolvers());
		const text = 'x'.repeat(4000);
		const result = await unevalStream(pending.map((p) => p.promise));
		for (const p of pending) p.resolve(text);
		const { root, blocks } = await drain(result);
		expect(blocks.join('').length).toBeLessThan(200_000);
		expect(await Promise.all(root)).toEqual(Array(2000).fill(text));
	});

	test('keeps primitive bindings local to concatenatable tail blocks', async () => {
		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		const third = Promise.withResolvers();
		const text = 'x'.repeat(2000);
		const result = await unevalStream([first.promise, second.promise, third.promise]);
		const target = client();
		const root = target.head(result.head);
		const blocks = [];
		for (const [pending, value] of [
			[first, 42],
			[second, [text, text]],
			[third, [text, text]]
		]) {
			pending.resolve(value);
			const { value: block, done } = await result.tail.next();
			expect(done).toBe(false);
			blocks.push(block);
			target.block(block);
		}
		expect(await Promise.all(root)).toEqual([42, [text, text], [text, text]]);
		expect(await Promise.all(target.combined(result.head, blocks))).toEqual([
			42,
			[text, text],
			[text, text]
		]);
	});

	test('supports more hoisted primitives than the function parameter limit', async () => {
		const strings = Array.from({ length: 66000 }, (_, i) => String(i).padStart(128, 'x'));
		const { restored, source } = await roundtrip([strings, strings.slice()]);
		expect(source.length).toBeLessThan(JSON.stringify([strings, strings]).length);
		expect(Array.from(restored[0])).toEqual(strings);
		expect(Array.from(restored[1])).toEqual(strings);
	});

	test('bounds cutoff strings and preserves other primitives alongside hoisted values', async () => {
		for (const length of [127, 128, 129]) {
			for (const character of ['x', '<']) {
				const value = Array(2000).fill(character.repeat(length));
				const { restored, source } = await roundtrip(value);
				expect(Array.from(restored)).toEqual(value);
				expect(source.includes('<')).toBe(false);
				expect(source.length).toBeLessThan(
					length < 128 ? value.length * (6 * length + 3) + 2 : 6 * length + 4 * value.length
				);
			}
		}
		const text = 'x'.repeat(256);
		const value = [text, text, 0, -0, NaN, Infinity, -Infinity, undefined, null, true, false, 1n];
		const { restored } = await roundtrip(value);
		for (let i = 0; i < value.length; i++) expect(Object.is(restored[i], value[i])).toBe(true);
	});

	test('deduplicates custom template holes without shadowing identifiers', async () => {
		class Box {
			constructor(value, marker) {
				this.value = value;
				this.marker = marker;
			}
		}
		const text = 'x'.repeat(4000);
		const boxes = Array.from({ length: 2000 }, () => new Box(text));
		const { restored, source } = await roundtrip(
			boxes,
			'tail',
			(value, js) => (value instanceof Box ? js`new Box(${value.value},p0)` : undefined),
			{ Box, p0: 'external' }
		);
		expect(source.length).toBeLessThan(100_000);
		expect(new Set(restored).size).toBe(2000);
		for (const box of restored) {
			expect(box.value).toBe(text);
			expect(box.marker).toBe('external');
		}
	});

	test('serializes typed arrays without Node globals', () => {
		execFileSync(process.execPath, [
			'--input-type=module',
			'--eval',
			`
			import assert from 'node:assert/strict';
			globalThis.Buffer = undefined;
			globalThis.process = undefined;
			const { unevalStream } = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
			const value = new Uint8Array([1,2,3]);
			assert.deepStrictEqual((0,eval)((await unevalStream(value)).head), value);
		`
		]);
	});

	for (const stage of ['construct', 'resolve']) {
		test(`deduplicates descriptor ${stage} holes without shadowing trusted names`, async () => {
			class Job {}
			const pending = Promise.withResolvers();
			const text = 'x'.repeat(4000);
			const result = await unevalStream(new Job(), (value, js) => {
				if (!(value instanceof Job)) return;
				const fragment = () => Array.from({ length: 2000 }, () => js`${text},`);
				// Nested fragments exercise holes inside capture instructions as well.
				const list = () => fragment().reduce((a, b) => js`${a}${b}`, js``);
				return {
					type: 'async-value',
					source: pending.promise,
					construct: (capture) =>
						stage === 'construct'
							? js`({values:${capture(js`[p0,${list()}]`)}})`
							: js`({values:[]})`,
					resolve: ({ target }) =>
						stage === 'resolve' ? js`${target}.values=[p0,${list()}]` : js``,
					reject: () => js``
				};
			});
			pending.resolve(1);
			const { root, blocks } = await drain(result, client({ p0: 'external' }));
			expect(root.values[0]).toBe('external');
			expect(Array.from(root.values).slice(1)).toEqual(Array(2000).fill(text));
			expect(result.head.length + blocks.join('').length).toBeLessThan(40_000);
		});
	}

	test('observes native promise rejections immediately, including failed traversals', () => {
		execFileSync(
			process.execPath,
			[
				'--unhandled-rejections=strict',
				'--input-type=module',
				'--eval',
				`
			import assert from 'node:assert/strict';
			import { setTimeout as delay } from 'node:timers/promises';
			import { unevalStream } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)};
			const result = await unevalStream({
				slow: delay(30, 42), failing: Promise.reject('first'),
				later: delay(10).then(() => { throw 'later'; }),
				nested: Promise.resolve({ failing: Promise.reject('nested') }),
				invalid: Promise.resolve(() => {})
			});
			const root = (0, eval)(result.head);
			for await (const block of result.tail) (0, eval)(block);
			assert.equal(await root.slow, 42);
			await assert.rejects(root.failing, reason => reason === 'first');
			await assert.rejects(root.later, reason => reason === 'later');
			await assert.rejects((await root.nested).failing, reason => reason === 'nested');
			await assert.rejects(root.invalid, /failed to serialize/);
			await assert.rejects(unevalStream({ failing: Promise.reject('abandoned'), invalid: () => {} }), /Cannot stringify a function/);
			class Job {}
			for (const invalid_construct of [false, true]) {
				await assert.rejects(unevalStream({ job: new Job(), invalid: () => {} }, (value, js) => {
					if (!(value instanceof Job)) return;
					return {
						type: 'async-value', source: Promise.reject('descriptor rejection'),
						construct: () => { if (invalid_construct) throw new Error('bad construct'); return js\`0\`; },
						resolve: () => js\`\`, reject: () => js\`\`
					};
				}), invalid_construct ? /bad construct/ : /Cannot stringify a function/);
			}
			const pending = Promise.withResolvers();
			const cancelled = await unevalStream(pending.promise);
			await cancelled.tail.return();
			pending.reject('after cancellation');
			await delay(50);
		`
			],
			{ timeout: 5000, stdio: 'pipe' }
		);
	});
});
