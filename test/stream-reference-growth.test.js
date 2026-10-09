import { expect, test } from 'vitest';
import { stringify, uneval, unevalStream } from '../src/index.js';
import { client, compare_topology, expect_roundtrip } from './helpers/stream.js';

/**
 * @param {'long key' | 'deep chain' | 'short flat key'} kind
 * @param {'head' | 'earlier tail'} origin
 */
async function reference_sizes(kind, origin) {
	const sizes = [];
	for (const n of [128, 256]) {
		const nodes = Array.from({ length: n }, (_, i) => ({ i }));
		let data;
		let key;
		if (kind === 'deep chain') {
			for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].next = nodes[i + 1];
			data = nodes[0];
		} else {
			key = kind === 'long key' ? '</script>'.repeat(n) : 'nodes';
			data = { [key]: nodes };
		}
		// Include the fresh outcome array in the linear input budget, without promises.
		const outcome = nodes.slice();
		const encoded = stringify({ data, outcome });
		const first = origin === 'earlier tail' ? Promise.withResolvers() : null;
		const second = origin === 'earlier tail' ? Promise.withResolvers() : null;
		const stream = unevalStream({
			data: first ? first.promise : data,
			outcome: second ? second.promise : Promise.resolve(outcome)
		});
		const c = client();
		const root = c.head(stream.head);
		let source = stream.head;
		let revived_data = root.data;
		if (first && second) {
			first.resolve(data);
			const block = await stream.tail.next();
			expect(block.done).toBe(false);
			source += block.value;
			c.block(block.value);
			revived_data = await root.data;
			// Only settle the fresh shallow array after its ancestors exist on the client.
			second.resolve(outcome);
		}
		for await (const block of stream.tail) {
			source += block;
			c.block(block);
		}

		const revived = await root.outcome;
		expect(revived).toHaveLength(n);
		if (kind !== 'deep chain') expect(revived).not.toBe(revived_data[key]);
		let node = kind === 'deep chain' ? revived_data : undefined;
		for (let i = 0; i < n; i += 1) {
			expect(revived[i]).toBe(kind === 'deep chain' ? node : revived_data[key][i]);
			expect(revived[i].i).toBe(i);
			if (kind === 'deep chain') node = node.next;
		}
		expect(new Set(revived).size).toBe(n);
		sizes.push({ n, input: encoded.length, output: source.length });
	}
	return sizes;
}

test.each(
	['head', 'earlier tail'].flatMap((origin) =>
		['long key', 'deep chain', 'short flat key'].map((kind) => ({ origin, kind }))
	)
)(
	'$origin: $kind references grow linearly across a later promise outcome',
	async ({ origin, kind }) => {
		// Identity checks for both sizes run before any output-size assertions.
		const sizes = await reference_sizes(kind, origin);
		expect
			.soft(sizes[1].output / sizes[0].output, 'doubling the input must not quadruple output')
			.toBeLessThan(2.5);
		for (const { n, input, output } of sizes) {
			// Allow escaping and generous per-node session/slot overhead, not repeated paths.
			expect
				.soft(output, `n=${n}: output exceeds the linear input budget`)
				.toBeLessThan(input * 8 + n * 192 + 4096);
		}
	}
);

test('cheap single-use and repeated leaf paths do not create lazy slots', async () => {
	const leaf = { value: 1 };
	const stream = unevalStream({ leaf, outcome: Promise.resolve([leaf, leaf]) }, undefined, {
		id: 'cheap'
	});
	const c = client();
	const root = c.head(stream.head);
	const slots = c.context.__d.cheap.o;
	expect(slots).toHaveLength(1);
	const blocks = [];
	for await (const block of stream.tail) {
		blocks.push(block);
		c.block(block);
	}
	const outcome = await root.outcome;
	expect(outcome[0]).toBe(root.leaf);
	expect(outcome[1]).toBe(root.leaf);
	// Only the new outcome array is retained, not its already-known leaf.
	expect(slots).toHaveLength(2);
	expect(blocks.join('')).toContain('s.o[0].leaf');
});

test('a long but bounded leaf read is repeated rather than given a slot', async () => {
	const key = 'x'.repeat(80);
	const leaf = { value: 1 };
	const stream = unevalStream({ [key]: leaf, outcome: Promise.resolve(leaf) }, undefined, {
		id: 'single'
	});
	const c = client();
	const root = c.head(stream.head);
	const slots = c.context.__d.single.o;
	for await (const block of stream.tail) c.block(block);
	expect(await root.outcome).toBe(root[key]);
	expect(slots).toHaveLength(1);
});

test('distinct descendants are reached by bounded paths from a numeric slot table', async () => {
	const key = 'x'.repeat(80);
	const nodes = Array.from({ length: 32 }, (_, i) => ({ i }));
	const stream = unevalStream(
		{ [key]: nodes, outcome: Promise.resolve(nodes.slice()) },
		undefined,
		{
			id: 'shared'
		}
	);
	const c = client();
	const root = c.head(stream.head);
	const slots = c.context.__d.shared.o;
	expect(slots).toHaveLength(1); // below the ceiling: no speculative head slots
	let source = stream.head;
	let tail = '';
	for await (const block of stream.tail) {
		source += block;
		tail += block;
		c.block(block);
	}
	const outcome = await root.outcome;
	for (let i = 0; i < nodes.length; i += 1) expect(outcome[i]).toBe(root[key][i]);
	// Each reference repeats a path of at most MAX_PATH_COST bytes; compression absorbs the repeats.
	expect(tail.split(key)).toHaveLength(nodes.length + 1);
	expect(Object.keys(slots)).toEqual(Array.from({ length: slots.length }, (_, i) => String(i)));
	expect(source.length).toBeLessThan(nodes.length * 128 + 1024);
});

test.each(['escaped segment', 'unicode segment', 'enormous segment', 'independent chains'])(
	'%s forces ceiling anchors even for a single later read',
	async (kind) => {
		const leaf = { value: 42 };
		let data = leaf;
		if (kind === 'independent chains') {
			for (let i = 0; i < 80; i += 1) data = { next: data };
			data = { left: data, right: structuredClone(data) };
		} else {
			const key =
				kind === 'unicode segment'
					? 'é'.repeat(64)
					: '<'.repeat(kind === 'escaped segment' ? 24 : 4096);
			data = { [key]: leaf };
		}
		const stream = unevalStream({ data, outcome: Promise.resolve(leaf) }, undefined, {
			id: 'ceiling'
		});
		const c = client();
		const root = c.head(stream.head);
		const slots = c.context.__d.ceiling.o;
		const before = slots.length;
		expect(before).toBeGreaterThan(1);
		let tail = '';
		for await (const block of stream.tail) {
			tail += block;
			c.block(block);
		}
		let revived = root.data;
		if (kind === 'independent chains') {
			expect(before).toBeGreaterThanOrEqual(7);
			revived = revived.left;
			for (let i = 0; i < 80; i += 1) revived = revived.next;
		} else revived = revived[Object.keys(data)[0]];
		expect(await root.outcome).toBe(revived);
		expect(slots).toHaveLength(before); // no profitable alias or new object
		expect(tail.length).toBeLessThan(256);
		expect(tail).not.toContain('\\u003C');
		if (kind === 'enormous segment') {
			// Includes the unavoidable original key literal, not just the tail.
			expect(stream.head.length + tail.length).toBeLessThan(stringify(data).length * 8 + 4096);
		}
	}
);

test('no-promise heads remain byte-compatible even when paths exceed the ceiling', async () => {
	const data = { ['<'.repeat(4096)]: { value: 1 } };
	const stream = unevalStream(data);
	expect(stream.head).toBe(uneval(data));
	expect(stream.head).not.toContain('s.o');
	expect(await stream.tail.next()).toEqual({ done: true, value: undefined });
});

test('a failed emission rolls back forced slots, lazy aliases and promise indices', async () => {
	const key = 'x'.repeat(80);
	const nodes = Array.from({ length: 32 }, (_, i) => ({ i }));
	const first = Promise.withResolvers();
	const second = Promise.withResolvers();
	const nested = Promise.resolve('nested');
	const errors = [];
	const stream = unevalStream(
		{ [key]: nodes, first: first.promise, second: second.promise },
		undefined,
		{ id: 'rollback', onerror: (error) => errors.push(error) }
	);
	const c = client();
	const root = c.head(stream.head);
	const slots = c.context.__d.rollback.o;
	// Fail during rendering (the second read), after demand planning has staged aliases.
	let reads = 0;
	const failing = {
		refs: nodes.slice(),
		['y'.repeat(256)]: { nested },
		get bad() {
			if (++reads === 2) throw new Error('render failed');
			return 1;
		}
	};
	first.resolve(failing);
	const failed = await stream.tail.next();
	c.block(failed.value);
	await expect(root.first).rejects.toThrow('failed to serialize');
	expect(errors).toHaveLength(1);
	expect(slots).toHaveLength(1);
	second.resolve({ refs: nodes.slice(), nested });
	let tail = '';
	for await (const block of stream.tail) {
		tail += block;
		c.block(block);
	}
	const outcome = await root.second;
	for (let i = 0; i < nodes.length; i += 1) expect(outcome.refs[i]).toBe(root[key][i]);
	expect(await outcome.nested).toBe('nested');
	expect(tail).toContain('s.d(2)');
	expect(Object.keys(slots)).toEqual(Array.from({ length: slots.length }, (_, i) => String(i)));
});

test('successful aliases in one block survive a later failing settlement', async () => {
	const key = 'x'.repeat(80);
	const nodes = Array.from({ length: 32 }, (_, i) => ({ i }));
	const promises = Array.from({ length: 3 }, () => Promise.withResolvers());
	const stream = unevalStream({ [key]: nodes, outcomes: promises.map((p) => p.promise) });
	const c = client();
	const root = c.head(stream.head);
	promises[0].resolve(nodes.slice());
	promises[1].resolve({ bad: () => {} });
	await Promise.resolve();
	const block = await stream.tail.next();
	c.block(block.value);
	const outcome = await root.outcomes[0];
	await expect(root.outcomes[1]).rejects.toThrow('failed to serialize');
	promises[2].resolve(nodes.slice());
	for await (const block of stream.tail) c.block(block);
	const reused = await root.outcomes[2];
	for (let i = 0; i < nodes.length; i += 1) {
		expect(outcome[i]).toBe(root[key][i]);
		expect(reused[i]).toBe(outcome[i]);
	}
});

test('forced anchors preserve cycles, sparse arrays and binary sharing without pooled bytes', async () => {
	const buffer = new ArrayBuffer(16);
	new Uint8Array(buffer).set([1, 2, 3, 4]);
	const pooled = Buffer.allocUnsafe(3);
	pooled.set([7, 8, 9]);
	const sparse = [];
	sparse.length = 0xffffffff;
	sparse[4000000000] = { value: 1 };
	const data = {
		buffer,
		view: new Uint16Array(buffer, 2, 3),
		other: new Uint8Array(buffer, 1, 5),
		data_view: new DataView(buffer, 3, 5),
		pooled,
		sparse,
		set: new Set(),
		map: new Map()
	};
	data.self = data;
	data.set.add(data);
	data.map.set(data, sparse);
	const key = '<'.repeat(24);
	const value = { [key]: data, outcome: Promise.resolve([data, buffer, data.view, sparse]) };
	const stream = unevalStream(value);
	const c = client();
	const root = c.head(stream.head);
	let source = stream.head;
	for await (const block of stream.tail) {
		source += block;
		c.block(block);
	}
	await compare_topology(value, root);
	expect(root[key].pooled.buffer.byteLength).toBe(3);
	expect(source.length).toBeLessThan(3000);
});

test('compact unshared typed-array emission is not changed by speculative buffer retention', async () => {
	const view = new Float64Array([1.5, -0, 2.5]);
	const stream = unevalStream({ view, outcome: Promise.resolve(view) });
	expect(stream.head).toContain('new Float64Array([1.5,-0,2.5])');
	expect(stream.head).not.toContain('new Uint8Array');
	const c = client();
	const root = c.head(stream.head);
	for await (const block of stream.tail) c.block(block);
	expect(await root.outcome).toBe(root.view);
});

test.each(['typed view', 'DataView'])(
	'%s preserves its buffer when the buffer path independently crosses the ceiling',
	async (kind) => {
		const buffer = new ArrayBuffer(24);
		new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);
		const view =
			kind === 'typed view' ? new Float64Array(buffer, 8, 1) : new DataView(buffer, 3, 5);
		const key = 'x'.repeat(124);
		const value = { [key]: view, outcome: Promise.resolve([view, buffer]) };
		const stream = unevalStream(value);
		const c = client();
		const root = c.head(stream.head);
		expect(stream.head).toContain('new Uint8Array');
		for await (const block of stream.tail) c.block(block);
		await compare_topology(value, root);
		expect((await root.outcome)[1]).toBe(root[key].buffer);
	}
);

test('replaced containers retain identity', async () => {
	class Box {
		constructor(value) {
			this.value = value;
		}
	}
	const key = 'x'.repeat(80);
	const nodes = Array.from({ length: 32 }, (_, i) => new Box({ i }));
	await expect_roundtrip((schedule) => ({ [key]: nodes, outcome: schedule.later(nodes.slice()) }), {
		replacer: (value, js) => value instanceof Box && js`new Box(${value.value})`,
		globals: { Box }
	});
});
