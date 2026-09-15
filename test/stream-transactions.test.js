import { describe, test, expect } from 'vitest';
import { DevalueError, unevalStream } from '../index.js';
import { client } from './helpers/stream.js';

describe('unevalStream transactions', () => {

	async function rejected(promise) {
		try { await promise; } catch (error) { return error; }
		expect.unreachable('expected rejection');
	}

	const delay = () => new Promise((resolve) => setTimeout(resolve, 5));

	test('rolls back a failed operation suffix before committing valid siblings', async () => {
		class Job {
			constructor(name, ready) {
				this.name = name;
				this.ready = ready;
			}
		}
		const failed_gate = Promise.withResolvers();
		const healthy_gate = Promise.withResolvers();
		const failed_nested_gate = Promise.withResolvers();
		const committed_nested_gate = Promise.withResolvers();
		const failed = new Job('failed', failed_gate);
		const healthy = new Job('healthy', healthy_gate);
		const failed_nested = new Job('failed nested', failed_nested_gate);
		const committed_nested = new Job('committed nested', committed_nested_gate);
		const shared = { value: 42 };
		const later_child = { retained: true };
		const later_outcome = { child: later_child, shared };
		const starts = [];
		const cancels = [];
		const reports = [];
		const source = (job) => ({
			get then() {
				starts.push(job.name);
				return job.ready.promise.then.bind(job.ready.promise);
			}
		});
		const result = await unevalStream({ shared, failed, healthy }, (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: source(value),
			construct: (capture) => value === failed_nested
				? js`({child:${later_child}})`
				: js`({name:${value.name},control:${capture(js`[]`)},value:null,nested:null})`,
			resolve: ({ target }, payload) => {
				if (value === failed) return js`${target}.nested=${failed_nested};${() => {}}`;
				if (value === healthy) return js`${target}.value=${payload};${target}.nested=${committed_nested}`;
				return js``;
			},
			reject: ({ target }) => value === failed ? js`${target}.value=${shared}` : js``,
			cancel() { cancels.push(value.name); }
		}), { id: 'transaction-suffix', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		expect(starts).toEqual(['failed', 'healthy']);
		failed_gate.resolve(1);
		healthy_gate.resolve(later_outcome);
		await delay();
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(reports.length).toBe(1);
		expect(starts).toEqual(['failed', 'healthy', 'committed nested']);
		expect(root.failed.value).toBe(root.shared);
		expect(root.healthy.value.child.retained).toBe(true);
		expect(root.healthy.value.shared).toBe(root.shared);
		expect(root.healthy.nested.name).toBe('committed nested');
		expect(!starts.includes('failed nested')).toBeTruthy();
		expect(cancels.includes('failed nested')).toBeFalsy();
		await result.tail.return();
		expect(cancels).toEqual(['failed', 'healthy', 'committed nested']);
	});

	test('keeps nested commits provisional when a later terminal callback aborts the batch', async () => {
		class Job {
			constructor(name, ready) {
				this.name = name;
				this.ready = ready;
			}
		}
		const first_gate = Promise.withResolvers();
		const fatal_gate = Promise.withResolvers();
		const nested_gate = Promise.withResolvers();
		const first = new Job('first', first_gate);
		const fatal = new Job('fatal', fatal_gate);
		const nested = new Job('nested', nested_gate);
		const starts = [];
		const cancels = [];
		let nested_constructs = 0;
		const result = await unevalStream({ first, fatal }, (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: {
				get then() {
					starts.push(value.name);
					return value.ready.promise.then.bind(value.ready.promise);
				}
			},
			construct: () => {
				if (value === nested) nested_constructs++;
				return js`({value:null})`;
			},
			resolve: ({ target }) => js`${target}.value=${nested}`,
			reject: () => value === fatal ? null : js``,
			cancel() { cancels.push(value.name); }
		}), { id: 'transaction-outer-rollback' });
		const target = client();
		const root = target.head(result.head);
		first_gate.resolve(1);
		fatal_gate.reject(new Error('fatal outcome'));
		await delay();
		const error = await rejected(result.tail.next());
		expect(error.message).toMatch(/fallback|reject\(\).*js tagged template/);
		expect(nested_constructs).toBe(1);
		expect(starts).toEqual(['first', 'fatal']);
		expect(cancels).toEqual(['first', 'fatal']);
		expect(root.first.value).toBe(null);
		expect(root.fatal.value).toBe(null);
		expect(!starts.includes('nested')).toBeTruthy();
		expect(cancels.includes('nested')).toBeFalsy();
	});

	test('continues cleanly after external, expired, and fresh owned graph failures', async () => {
		class Job {
			constructor(name, ready) {
				this.name = name;
				this.ready = ready;
			}
		}
		const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
		const external_job = new Job('external', gates[0]);
		const symbol_job = new Job('symbol', gates[1]);
		const reused_job = new Job('reused', gates[2]);
		const graph_job = new Job('graph', gates[3]);
		const healthy_job = new Job('healthy', gates[4]);
		const provisional = new Job('provisional', gates[5]);
		const nested = new Job('nested', gates[6]);
		const shared = { value: 42 };
		const external_value = {};
		const external_root = {};
		const external = new DevalueError('external failure', ['.external'], external_value, external_root);
		Object.freeze(external);
		const external_hole = { provisional };
		Object.defineProperty(external_hole, 'prop', { enumerable: true, get() { throw external; } });
		const reused_hole = { provisional };
		Object.defineProperty(reused_hole, 'prop', { enumerable: true, get() { throw reports[1]; } });
		const bad = () => {};
		const graph_hole = { deep: { bad } };
		const starts = [];
		const cancels = [];
		const reports = [];
		const result = await unevalStream({ shared, jobs: [external_job, symbol_job, reused_job, graph_job, healthy_job] }, (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: {
				get then() {
					starts.push(value.name);
					return value.ready.promise.then.bind(value.ready.promise);
				}
			},
			construct: () => js`({name:${value.name},value:null})`,
			resolve: ({ target }) => {
				if (value === external_job) return js`${external_hole}`;
				if (value === reused_job) return js`${reused_hole}`;
				if (value === graph_job) return js`${graph_hole}`;
				if (value === healthy_job) return js`${target}.value={shared:${shared},again:${shared},nested:${nested}}`;
				return js`${target}.value="done"`;
			},
			reject: ({ target }, error) => js`${target}.value=${error}`,
			cancel() { cancels.push(value.name); }
		}), { id: 'owned-error-rollback', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		expect(starts).toEqual(['external', 'symbol', 'reused', 'graph', 'healthy']);

		gates[0].resolve(1);
		target.block((await result.tail.next()).value);
		expect(reports[0].cause).toBe(external);
		expect(external.path).toBe('.external');
		expect(external.value).toBe(external_value);
		expect(external.root).toBe(external_root);
		expect(!starts.includes('provisional')).toBeTruthy();
		expect(!cancels.includes('provisional')).toBeTruthy();

		const symbol = Symbol('reported');
		gates[1].resolve(symbol);
		target.block((await result.tail.next()).value);
		expect(reports[1]).toBeInstanceOf(DevalueError);
		expect(reports[1].value).toBe(symbol);
		expect(reports[1].path).toBe('');

		gates[2].resolve(1);
		target.block((await result.tail.next()).value);
		expect(reports[2].cause).toBe(reports[1]);
		expect(reports[1].path).toBe('');
		expect(!starts.includes('provisional')).toBeTruthy();
		expect(!cancels.includes('provisional')).toBeTruthy();

		gates[3].resolve(2);
		target.block((await result.tail.next()).value);
		expect(reports[3].cause.value).toBe(bad);
		expect(reports[3].cause.path).toBe('.deep.bad');

		gates[4].resolve(3);
		const healthy_block = (await result.tail.next()).value;
		target.block(healthy_block);
		expect(starts).toEqual(['external', 'symbol', 'reused', 'graph', 'healthy', 'nested']);
		expect(root.jobs[4].value.shared).toBe(root.shared);
		expect(root.jobs[4].value.again).toBe(root.shared);
		expect(root.jobs[4].value.nested.name).toBe('nested');

		gates[6].resolve(4);
		target.block((await result.tail.next()).value);
		expect(root.jobs[4].value.nested.value).toBe('done');
		expect(reports.length).toBe(4);
		await result.tail.return();
		expect(cancels).toEqual([]);
	});

	test('keeps head-retained opaque descendants usable after an operation rollback', async () => {
		class Wrapper {
			constructor(value) {
				this.value = value;
			}
		}
		class Job {
			constructor(ready, fails) {
				this.ready = ready;
				this.fails = fails;
			}
		}
		const failed_gate = Promise.withResolvers();
		const healthy_gate = Promise.withResolvers();
		const failed = new Job(failed_gate, true);
		const healthy = new Job(healthy_gate, false);
		const leaf = { retained: true };
		const parent = { child: leaf };
		const reports = [];
		const result = await unevalStream({
			wrappers: [new Wrapper(leaf), new Wrapper(parent)],
			failed,
			healthy
		}, (value, js) => {
			if (value instanceof Wrapper) return js`({value:${value.value}})`;
			if (!(value instanceof Job)) return;
			return {
				type: 'async-value',
				source: value.ready.promise,
				construct: () => js`({value:null})`,
				resolve: ({ target }) => value.fails ? js`${{ invalid: () => {} }}` : js`${target}.value=${leaf}`,
				reject: ({ target }) => js`${target}.value=${leaf}`
			};
		}, { id: 'opaque-operation-rollback', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		failed_gate.resolve(1);
		healthy_gate.resolve(2);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(reports.length).toBe(1);
		expect(root.failed.value).toBe(root.wrappers[0].value);
		expect(root.healthy.value).toBe(root.wrappers[0].value);
		expect(root.wrappers[1].value.child).toBe(root.wrappers[0].value);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('keeps overlapping ordinary operation holes healthy after a failed operation rollback', async () => {
		class Job {
			constructor(ready) {
				this.ready = ready;
			}
		}
		const failed_gate = Promise.withResolvers();
		const healthy_gate = Promise.withResolvers();
		const failed = new Job(failed_gate);
		const healthy = new Job(healthy_gate);
		const r1 = { value: 42 };
		const r2 = { child: r1 };
		const reports = [];
		const result = await unevalStream({ failed, healthy }, (value, js) => {
			if (!(value instanceof Job)) return;
			const template = ({ target }) => js`${target}.value=${r2};${target}.also=${r1}`;
			return {
				type: 'async-value',
				source: value.ready.promise,
				construct: (capture) => js`({value:null,also:null,control:${capture(js`[]`)}})`,
				// The failed operation provisions the same overlapping ordinary holes as the
				// healthy fallback; its rollback must leave no anchors, slots, or promises.
				resolve: ({ target }) => value === failed ? js`${target}.value=${r2};${target}.also=${r1};${{ invalid: () => {} }}` : template({ target }),
				reject: template,
				cancel() {}
			};
		}, { id: 'ordinary-operation-rollback', onerror: (error) => reports.push(error) });
		const target = client();
		const root = target.head(result.head);
		failed_gate.resolve(1);
		healthy_gate.resolve(2);
		const block = (await result.tail.next()).value;
		target.block(block);
		expect(reports.length).toBe(1);
		expect(reports[0].message).toMatch(/Cannot stringify a function/);
		expect(root.failed.value).toBe(root.healthy.value);
		expect(root.failed.value.child).toBe(root.failed.also);
		expect(root.failed.value.child).toBe(root.healthy.also);
		expect(root.failed.value.child.value).toBe(42);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

});
