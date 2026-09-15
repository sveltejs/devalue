import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import { unevalStream } from '../index.js';
import { client } from './helpers/stream.js';

// Deterministic size and complexity budgets. These are generous upper bounds
// with ~25% headroom over measured output: they exist to catch accidental
// output expansion (duplicated runtime helpers, per-outcome anchors, whole
// container copies), never to forbid more compact output. Actual raw sizes
// are included in every assertion message. Real wall-clock timing remains
// the domain of `pnpm bench`, not these tests.

describe('unevalStream performance budgets', () => {

	test('keeps the pending primitive Promise protocol compact', async () => {
		const pending = Promise.withResolvers();
		const result = await unevalStream(pending.promise, undefined, { id: 'size' });
		pending.resolve(1);
		const block = (await result.tail.next()).value;
		const message = `head=${result.head.length} tail=${block.length}`;
		// measured 211 for head; the budget guards the one-promise runtime
		// against growing helper or namespace duplication
		expect(result.head.length, message).toBeLessThan(270);
		expect(block.length, message).toBeLessThan(130);
	});

	test('keeps the native sequence adapter runtime compact', async () => {
		const source = { async *[Symbol.asyncIterator]() { yield 1; return 2; } };
		const result = await unevalStream(source, undefined, { id: 'native-size' });
		const message = `head=${result.head.length}`;
		// measured 1304 for head; the budget guards the queue runtime that
		// every native sequence ships, including its definition cost once
		expect(result.head.length, message).toBeLessThan(1650);
	});

	test('keeps many repeated outcomes compact without per-outcome anchors', async () => {
		const hold = Promise.withResolvers();
		const repeated = { value: 1 };
		const source = {
			async *[Symbol.asyncIterator]() {
				for (let i = 0; i < 100; i += 1) yield repeated;
			}
		};
		const result = await unevalStream({ source, hold: hold.promise }, undefined, { id: 'repeated-budget' });
		const target = client();
		const root = target.head(result.head);
		hold.resolve('done');
		const seen = [];
		const reading = (async () => {
			for await (const value of root.source) seen.push(value);
		})();
		let emitted = result.head.length;
		for await (const block of result.tail) {
			emitted += block.length;
			target.block(block);
		}
		await reading;
		const message = `head=${result.head.length} emitted=${emitted} per-outcome=${(emitted - result.head.length) / 100}`;
		// repeating one identity 100 times must reuse its anchor: each outcome
		// stays a small delivered block (~65 bytes measured) instead of
		// re-anchoring or copying the repeated value per outcome
		expect(seen.length).toBe(100);
		expect(emitted, message).toBeLessThan(result.head.length + 100 * 100);
	});

	test('trips on whole-Map and whole-Set copies of scalar Promise state', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/scalar-scaling.mjs', import.meta.url));
		const child = spawnSync(process.execPath, [fixture, '100', '200', '400'], { encoding: 'utf8', timeout: 30_000 });
		expect(child.error, child.error?.stack).toBe(undefined);
		expect(child.signal, child.stderr || child.stdout).toBe(null);
		expect(child.status, child.stderr || child.stdout).toBe(0);
		const measurement = JSON.parse(child.stdout);
		expect(measurement.results.map((result) => result.count)).toEqual([100, 200, 400]);
		for (const result of measurement.results) {
			// narrow instrumentation: this is a regression tripwire for whole
			// container copying during scalar Promise transactions, not a
			// general complexity contract. A whole-copy regression copies ~count
			// entries; incidental small copies stay far below it.
			expect(result.copied_entries, JSON.stringify(measurement)).toBeLessThanOrEqual(16);
			expect(result.copied_containers, JSON.stringify(measurement)).toBeLessThanOrEqual(16);
			expect(result.bytes > 0, JSON.stringify(measurement)).toBeTruthy();
		}
	});

	test('keeps overlapping opaque-root retention proportional to captured nodes', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/retained-scaling.mjs', import.meta.url));
		const child = spawnSync(process.execPath, [fixture, '100', '200', '400', '800'], {
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(child.error, child.error?.stack).toBe(undefined);
		expect(child.signal, child.stderr || child.stdout).toBe(null);
		expect(child.status, child.stderr || child.stdout).toBe(0);
		const measurement = JSON.parse(child.stdout);
		expect(measurement.results.map((result) => result.count)).toEqual([100, 200, 400, 800]);
		for (const result of measurement.results) {
			// narrow instrumentation: Map.get probes bound the retained-graph
			// lookup work; they are not proof of general big-O complexity
			expect(result.map_gets <= 80 * result.count + 1_000, JSON.stringify(measurement)).toBeTruthy();
			expect(result.bytes > 0, JSON.stringify(measurement)).toBeTruthy();
		}
	});

	test('keeps descriptor-root best-path traversal proportional to operation holes', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/operation-holes-scaling.mjs', import.meta.url));
		const child = spawnSync(process.execPath, [fixture, '100', '200', '400', '800'], {
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(child.error, child.error?.stack).toBe(undefined);
		expect(child.signal, child.stderr || child.stdout).toBe(null);
		expect(child.status, child.stderr || child.stdout).toBe(0);
		const measurement = JSON.parse(child.stdout);
		expect(measurement.results.map((result) => result.count)).toEqual([100, 200, 400, 800]);
		for (const result of measurement.results) {
			expect(result.map_gets <= 80 * result.count + 1_000, JSON.stringify(measurement)).toBeTruthy();
			expect(result.bytes > 0, JSON.stringify(measurement)).toBeTruthy();
		}
	});

	test('keeps per-event scratch proportional when a later batch re-reaches earlier roots', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/operation-holes-scaling.mjs', import.meta.url));
		const child = spawnSync(process.execPath, [fixture, '--events', '100', '200', '400', '800'], {
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(child.error, child.error?.stack).toBe(undefined);
		expect(child.signal, child.stderr || child.stdout).toBe(null);
		expect(child.status, child.stderr || child.stdout).toBe(0);
		const measurement = JSON.parse(child.stdout);
		expect(measurement.results.map((result) => result.count)).toEqual([100, 200, 400, 800]);
		for (const result of measurement.results) {
			expect(result.event1.map_gets <= 80 * result.count + 1_000, JSON.stringify(measurement)).toBeTruthy();
			expect(result.event2.map_gets <= 80 * result.count + 1_000, JSON.stringify(measurement)).toBeTruthy();
		}
	});

	test('collects nested synchronous source holes with linear append work', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/source-values-scaling.mjs', import.meta.url));
		const child = spawnSync(process.execPath, [fixture, '100', '200', '400', '800'], {
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(child.error, child.error?.stack).toBe(undefined);
		expect(child.signal, child.stderr || child.stdout).toBe(null);
		expect(child.status, child.stderr || child.stdout).toBe(0);
		const measurement = JSON.parse(child.stdout);
		expect(measurement.results.map((result) => result.count)).toEqual([100, 200, 400, 800]);
		for (const result of measurement.results) {
			expect(result.appended <= result.count * 2, JSON.stringify(measurement)).toBeTruthy();
		}
	});

});
