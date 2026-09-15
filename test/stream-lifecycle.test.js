import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import { unevalStream } from '../index.js';

describe('unevalStream lifecycle', () => {

	const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

	async function rejected(promise) {
		let did_reject = false;
		let reason;
		try {
			await promise;
		} catch (error) {
			did_reject = true;
			reason = error;
		}
		expect(did_reject).toBe(true);
		return reason;
	}

	function settled(promise) {
		return promise.then(
			(value) => ({ ok: true, value }),
			(reason) => ({ ok: false, reason })
		);
	}

	function listeners(signal) {
		return getEventListeners(signal, 'abort').length;
	}

	function null_prototype_callable(callback) {
		return Object.setPrototypeOf(callback, null);
	}

	function sequence_descriptor(value, js, cancel) {
		return {
			type: 'async-sequence',
			source: value.source,
			construct: () => js`({events:[]})`,
			next: ({ target }, item) => js`${target}.events.push(${item})`,
			complete: () => js``,
			error: () => js``,
			cancel
		};
	}

	test('keeps cleanup diagnostics isolated from disposed source getters', () => {
		const fixture = fileURLToPath(new URL('../fixtures/stream/cleanup-diagnostics.mjs', import.meta.url));
		const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', fixture], {
			encoding: 'utf8',
			timeout: 10_000
		});
		expect(child.error, child.error?.stack).toBe(undefined);
		expect(child.signal, child.stderr || child.stdout).toBe(null);
		expect(child.status, child.stderr || child.stdout).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ fixture: 'cleanup diagnostics', cases: 5 });
	});

	test('detaches abort listeners on every successful completion path', async () => {
		{
			const controller = new AbortController();
			const before = listeners(controller.signal);
			await unevalStream({ value: 1 }, undefined, { signal: controller.signal });
			expect(listeners(controller.signal)).toBe(before);
		}

		{
			const controller = new AbortController();
			let cancels = 0;
			class Job {}
			const result = await unevalStream(new Job(), (_value, js) => ({
				type: 'async-value',
				source: Promise.resolve(1),
				construct: () => js`0`,
				resolve: () => js``,
				reject: () => js``,
				cancel() { cancels++; }
			}), { signal: controller.signal });
			expect(listeners(controller.signal)).toBe(0);
			controller.abort(new Error('late'));
			expect(cancels).toBe(0);
			expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		}

		{
			const controller = new AbortController();
			const pending = Promise.withResolvers();
			const result = await unevalStream(pending.promise, undefined, { signal: controller.signal });
			expect(listeners(controller.signal)).toBe(1);
			pending.resolve(1);
			const final = await result.tail.next();
			expect(final.done).toBe(false);
			// Delivery of the final block, not a gratuitous extra next(), finalizes the server session.
			expect(listeners(controller.signal)).toBe(0);
			controller.abort(new Error('late'));
			expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		}

		{
			const controller = new AbortController();
			const source = { async *[Symbol.asyncIterator]() { yield 1; yield 2; } };
			const result = await unevalStream(source, undefined, { signal: controller.signal });
			for await (const _block of result.tail) {}
			expect(listeners(controller.signal)).toBe(0);
		}
	});

	test('preserves exact falsy abort reasons', async () => {
		for (const reason of [null, 0, false, '']) {
			const pre = new AbortController();
			pre.abort(reason);
			expect(await rejected(unevalStream({}, undefined, { signal: pre.signal }))).toBe(reason);

			const controller = new AbortController();
			const result = await unevalStream(new Promise(() => {}), undefined, { signal: controller.signal });
			const next = result.tail.next();
			controller.abort(reason);
			expect(await rejected(next)).toBe(reason);
		}
	});

	test('does not wait for an abandoned pull when return is absent or completes', async () => {
		for (const has_return of [false, true]) {
			const pull = Promise.withResolvers();
			let returns = 0;
			const source = {
				[Symbol.asyncIterator]() { return this; },
				next() { return pull.promise; }
			};
			if (has_return) source.return = () => { returns++; return { done: true }; };
			const result = await unevalStream(source);
			const waiting = result.tail.next();
			try {
				expect(await result.tail.return()).toEqual({ done: true, value: undefined });
				expect(await waiting).toEqual({ done: true, value: undefined });
				expect(returns).toBe(has_return ? 1 : 0);
			} finally {
				pull.resolve({ done: true });
			}
		}
	});

	test('notifies every source before awaiting cleanup and is reentry-safe', async () => {
		const controller = new AbortController();
		const close_gate = Promise.withResolvers();
		const calls = [];
		class Sequence {
			constructor(name) {
				this.name = name;
				this.pull = Promise.withResolvers();
				this.source = {
					[Symbol.asyncIterator]: () => this.source,
					next: () => this.pull.promise,
					return: () => {
						calls.push(`return:${this.name}`);
						return this.name === 'first' ? close_gate.promise : { done: true };
					}
				};
			}
		}
		const values = [new Sequence('first'), new Sequence('second')];
		const abort_reason = new Error('cleanup reentry');
		const result = await unevalStream(values, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
			calls.push(`cancel:${value.name}`);
			controller.abort(abort_reason);
		}), { signal: controller.signal });
		const returning = result.tail.return();
		// the abort fires reentrantly while the first return() is still gated: every hook
		// still fires exactly once, in source order, before anything is awaited
		expect(calls).toEqual(['return:first', 'cancel:first', 'return:second', 'cancel:second']);
		expect(controller.signal.aborted).toBe(true);
		close_gate.resolve({ done: true });
		// lifecycle listeners detach when cancellation begins, so the mid-cleanup abort
		// cannot duplicate hooks or promote its reason over the reason-less return():
		// the tail reports the ordinary successful cancellation result
		expect(await returning).toEqual({ done: true, value: undefined });
		expect(calls).toEqual(['return:first', 'cancel:first', 'return:second', 'cancel:second']);
		for (const value of values) value.pull.resolve({ done: true });
	});

	test('return getter reentry invokes return and cancel at most once', async () => {
		const calls = [];
		const pull = Promise.withResolvers();
		let reenter = () => {};
		const iterator = {
			next() { return pull.promise; },
			get return() {
				calls.push('get return');
				reenter();
				return () => { calls.push('return'); return { done: true }; };
			}
		};
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const value = { source };
		const result = await unevalStream(value, (candidate, js) => candidate === value && sequence_descriptor(candidate, js, () => { calls.push('cancel'); }));
		reenter = () => { void result.tail.return(); };
		expect(await result.tail.return()).toEqual({ done: true, value: undefined });
		expect(calls).toEqual(['get return', 'return', 'cancel']);
		pull.resolve({ done: true });
	});

	test('return and cancel getter failures are observed once in operation order', async () => {
		const return_failure = { kind: 'return getter' };
		const cancel_failure = { kind: 'cancel getter' };
		const reports = [];
		let return_gets = 0;
		let cancel_gets = 0;
		const iterator = {
			next: () => new Promise(() => {}),
			get return() {
				return_gets++;
				throw return_failure;
			}
		};
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const value = { source };
		const descriptor = sequence_descriptor(value, undefined);
		Object.defineProperty(descriptor, 'cancel', {
			get() {
				cancel_gets++;
				if (cancel_gets === 1) return () => {};
				throw cancel_failure;
			}
		});
		const result = await unevalStream(value, (candidate, js) => {
			if (candidate !== value) return;
			descriptor.construct = () => js`({events:[]})`;
			descriptor.next = ({ target }, item) => js`${target}.events.push(${item})`;
			descriptor.complete = () => js``;
			descriptor.error = () => js``;
			return descriptor;
		}, { onerror: (error) => reports.push(error) });
		expect(await rejected(result.tail.return())).toBe(return_failure);
		expect(reports).toEqual([cancel_failure]);
		expect(return_gets).toBe(1);
		expect(cancel_gets).toBe(2);
		expect(await result.tail.return()).toEqual({ done: true, value: undefined });
		expect(return_gets).toBe(1);
		expect(cancel_gets).toBe(2);
	});

	test('abort during initial traversal leaves every provisional descriptor untouched', async () => {
		const controller = new AbortController();
		const calls = [];
		class Job {
			constructor(name) { this.name = name; }
		}
		const values = [new Job('committed'), new Job('provisional')];
		const replacer = (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: new Promise(() => {}),
			construct() {
				if (value.name === 'provisional') controller.abort('stop');
				return js`0`;
			},
			resolve: () => js``,
			reject: () => js``,
			cancel() { calls.push(value.name); }
		});
		// The root capture is one transaction, so neither source is committed until it completes.
		expect(await rejected(unevalStream(values, replacer, { signal: controller.signal }))).toBe('stop');
		expect(calls).toEqual([]);
	});

	test('abort during outcome traversal cancels prior sources but not the rolled-back descriptor', async () => {
		const controller = new AbortController();
		const outcome = Promise.withResolvers();
		const calls = [];
		class Nested {}
		class Outer {}
		const outer = new Outer();
		const result = await unevalStream(outer, (value, js) => {
			if (value === outer) return {
				type: 'async-value', source: outcome.promise, construct: () => js`0`,
				resolve: () => js``, reject: () => js``, cancel() { calls.push('outer'); }
			};
			if (value instanceof Nested) return {
				type: 'async-value', source: new Promise(() => {}),
				construct() { controller.abort('stop'); return js`0`; },
				resolve: () => js``, reject: () => js``, cancel() { calls.push('nested'); }
			};
		}, { signal: controller.signal });
		const waiting = result.tail.next();
		outcome.resolve(new Nested());
		expect(await rejected(waiting)).toBe('stop');
		expect(calls).toEqual(['outer']);
	});

	test('abort during operation generation stops later callbacks', async () => {
		const controller = new AbortController();
		const first = Promise.withResolvers();
		const second = Promise.withResolvers();
		const calls = [];
		class Job {
			constructor(name, source) { this.name = name; this.source = source; }
		}
		const jobs = [new Job('first', first), new Job('second', second)];
		const result = await unevalStream(jobs, (value, js) => value instanceof Job && ({
			type: 'async-value', source: value.source.promise, construct: () => js`0`,
			resolve() {
				calls.push(value.name);
				if (value.name === 'first') controller.abort('stop');
				return js``;
			},
			reject: () => js``,
			cancel() {}
		}), { signal: controller.signal });
		const waiting = result.tail.next();
		first.resolve(1);
		second.resolve(2);
		expect(await rejected(waiting)).toBe('stop');
		expect(calls).toEqual(['first']);
	});

	test('stops descriptor validation and construction after getter-triggered aborts', async () => {
		{
			const controller = new AbortController();
			const reason = { trigger: 'descriptor discriminant presence' };
			let type_reads = 0;
			const descriptor = new Proxy({}, {
				getOwnPropertyDescriptor(_target, key) {
					if (key === 'type') controller.abort(reason);
					return { configurable: true, enumerable: true, value: 'async-value' };
				},
				get(_target, key) {
					if (key === 'type') type_reads++;
				}
			});
			expect(await rejected(unevalStream({}, () => descriptor, { signal: controller.signal }))).toBe(reason);
			expect(type_reads).toBe(0);
		}
		const cases = [
			{ kind: 'value', trigger: 'type' },
			{ kind: 'sequence', trigger: 'type' },
			{ kind: 'value', trigger: 'source' },
			{ kind: 'sequence', trigger: 'source' },
			{ kind: 'value', trigger: 'resolve' },
			{ kind: 'sequence', trigger: 'next' },
			{ kind: 'value', trigger: 'cancel' },
			{ kind: 'sequence', trigger: 'cancel' }
		];
		for (const current of cases) {
			const controller = new AbortController();
			const reason = { kind: current.kind, trigger: current.trigger };
			const calls = [];
			const descriptor = {};
			// each getter aborts on its first relevant access: no repeated
			// descriptor lookup is required to trigger cancellation
			Object.defineProperty(descriptor, 'type', {
				enumerable: true,
				get() {
					calls.push('type');
					if (current.trigger === 'type') controller.abort(reason);
					return current.kind === 'value' ? 'async-value' : 'async-sequence';
				}
			});
			const promise = new Promise(() => {});
			const iterable = { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); } };
			Object.defineProperty(descriptor, 'source', {
				enumerable: true,
				get() {
					calls.push('source');
					if (current.trigger === 'source') controller.abort(reason);
					return current.kind === 'value' ? promise : iterable;
				}
			});
			const keys = current.kind === 'value'
				? ['construct', 'resolve', 'reject']
				: ['construct', 'next', 'complete', 'error'];
			for (const key of keys) {
				Object.defineProperty(descriptor, key, {
					enumerable: true,
					get() {
						calls.push(`get:${key}`);
						if (current.trigger === key) controller.abort(reason);
						return () => { calls.push(`call:${key}`); };
					}
				});
			}
			Object.defineProperty(descriptor, 'cancel', {
				enumerable: true,
				get() {
					calls.push('get:cancel');
					if (current.trigger === 'cancel') controller.abort(reason);
					return () => { calls.push(`call:cancel`); };
				}
			});
			expect(await rejected(unevalStream({}, () => descriptor, { signal: controller.signal }))).toBe(reason);
			// once cancellation is triggered, no method is invoked and no later
			// descriptor stage runs, whatever lookup order the implementation uses
			expect(calls).not.toContain('call:construct');
			for (const key of keys) expect(calls).not.toContain(`call:${key}`);
			expect(calls).not.toContain('call:cancel');
			if (current.trigger === 'type' || current.trigger === 'source') {
				expect(calls).not.toContain('get:construct');
			}
			if (current.trigger === 'type') {
				expect(calls).not.toContain('source');
			}
		}
	});

	test('does not invoke a construct method acquired after nested cancellation', async () => {
		const controller = new AbortController();
		const gate = Promise.withResolvers();
		const reason = { kind: 'construct getter abort' };
		const calls = [];
		class Outer {}
		class Nested {}
		const outer = new Outer();
		const result = await unevalStream(outer, (value, js) => {
			if (value === outer) return {
				type: 'async-value', source: gate.promise,
				construct: () => js`0`, resolve: (_reference, outcome) => js`${outcome}`,
				reject: () => js``, cancel() { calls.push('outer:cancel'); }
			};
			if (value instanceof Nested) {
				const descriptor = {
					type: 'async-value', source: new Promise(() => {}),
					resolve: () => js``, reject: () => js``,
					cancel() { calls.push('nested:cancel'); }
				};
				// aborting on the first construct acquisition: the method must be
				// acquired-but-never-invoked once cancellation has been triggered
				Object.defineProperty(descriptor, 'construct', {
					get() {
						calls.push('nested:get construct');
						controller.abort(reason);
						return () => { calls.push('nested:construct'); return js`0`; };
					}
				});
				return descriptor;
			}
		}, { signal: controller.signal });
		const waiting = settled(result.tail.next());
		gate.resolve(new Nested());
		const outcome = await waiting;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe(reason);
		expect(calls).toEqual(['nested:get construct', 'outer:cancel']);
	});

	test('guards startup acquisition boundaries against getter-triggered aborts', async () => {
		const cases = [
			{ kind: 'value', boundary: 'method' },
			{ kind: 'sequence', boundary: 'method' },
			{ kind: 'sequence', boundary: 'iterator next' },
			{ kind: 'sequence', boundary: 'iterator result' }
		];
		for (const { kind, boundary } of cases) {
			const controller = new AbortController();
			const reason = { kind, boundary };
			const calls = [];
			let tag;
			const result_object = {
				get done() {
					calls.push('result:done');
					if (boundary === 'iterator result') controller.abort(reason);
					return false;
				},
				get value() {
					calls.push('result:value');
					return 1;
				}
			};
			const iterator = {};
			Object.defineProperty(iterator, 'next', {
				get() {
					calls.push('acquire:next');
					if (boundary === 'iterator next') controller.abort(reason);
					return () => {
						calls.push('pull');
						return Promise.resolve(result_object);
					};
				}
			});
			const observed = {};
			Object.defineProperty(observed, kind === 'value' ? 'then' : Symbol.asyncIterator, {
				get() {
					calls.push('method');
					if (boundary === 'method') controller.abort(reason);
					return function (resolve) {
						calls.push('invoke');
						if (kind === 'value') resolve(1);
						else return iterator;
					};
				}
			});
			const descriptor = {
				type: kind === 'value' ? 'async-value' : 'async-sequence',
				source: observed,
				construct: (_capture) => tag`0`,
				resolve: () => tag``, reject: () => tag``,
				next: () => tag``, complete: () => tag``, error: () => tag``,
				cancel() { calls.push('cancel'); }
			};
			expect(await rejected(unevalStream({}, (_value, js) => { tag = js; return descriptor; }, { signal: controller.signal }))).toBe(reason);
			// cancellation at an acquisition boundary stops the startup sequence:
			// no forbidden invocation or pull follows the abort
			expect(calls).toContain('cancel');
			if (boundary === 'method') {
				expect(calls).not.toContain('invoke');
				expect(calls).not.toContain('acquire:next');
			}
			if (boundary === 'iterator next') {
				expect(calls).not.toContain('pull');
			}
			if (boundary === 'iterator result') {
				expect(calls).toContain('pull');
				expect(calls.filter((call) => call === 'pull').length).toBe(1);
			}
		}
	});

	test('does not invoke operation or fallback methods acquired after cancellation', async () => {
		for (const phase of ['resolve', 'reject', 'next', 'complete', 'error', 'fallback reject', 'fallback error']) {
			const sequence = phase === 'next' || phase === 'complete' || phase === 'error' || phase === 'fallback error';
			const fallback = phase.startsWith('fallback');
			const method_name = fallback ? (sequence ? 'error' : 'reject') : phase;
			const controller = new AbortController();
			const reason = phase === 'resolve' ? 0 : { phase };
			const gate = Promise.withResolvers();
			const calls = [];
			let tag;
			let armed = false;
			let method_reads = 0;
			let method_calls = 0;
			let pulls = 0;
			let returns = 0;
			const iterable = {
				[Symbol.asyncIterator]() { return this; },
				next() { pulls++; return gate.promise; },
				return() { returns++; return { done: true }; }
			};
			const descriptor = {
				type: sequence ? 'async-sequence' : 'async-value',
				source: sequence ? iterable : gate.promise,
				construct: () => tag`0`,
				resolve() { calls.push('resolve'); return fallback ? null : tag``; },
				reject() { calls.push('reject'); return tag``; },
				next() { calls.push('next'); return fallback ? null : tag``; },
				complete() { calls.push('complete'); return tag``; },
				error() { calls.push('error'); return tag``; },
				cancel() { calls.push('cancel'); }
			};
			Object.defineProperty(descriptor, method_name, {
				get() {
					method_reads++;
					// the outcome boundary is armed externally: the getter's next access
					// is the operation acquisition for the settled outcome, and that
					// first relevant access triggers the abort
					if (armed) controller.abort(reason);
					const method = function () {
						method_calls++;
						return tag``;
					};
					Object.defineProperty(method, 'call', {
						value: () => expect.unreachable('operation must not consult method.call')
					});
					return method;
				}
			});
			const reports = [];
			const result = await unevalStream({}, (_value, js) => { tag = js; return descriptor; }, {
				signal: controller.signal,
				onerror: (error) => reports.push(error)
			});
			const waiting = settled(result.tail.next());
			armed = true;
			if (!sequence) {
				if (phase === 'reject') gate.reject({ phase });
				else gate.resolve(1);
			} else if (phase === 'error') {
				gate.reject({ phase });
			} else {
				gate.resolve({ done: phase === 'complete', value: 1 });
			}
			const outcome = await waiting;
			expect(outcome.ok).toBe(false);
			expect(outcome.reason).toBe(reason);
			expect(method_reads).toBeGreaterThanOrEqual(1);
			expect(method_calls).toBe(0);
			expect(pulls).toBe(sequence ? 1 : 0);
			expect(returns).toBe(sequence ? 1 : 0);
			expect(calls.at(-1)).toBe('cancel');
			expect(reports.length).toBe(fallback ? 1 : 0);
		}
	});

	test('preserves descriptor and startup receivers', async () => {
		for (const kind of ['value', 'sequence']) {
			let tag;
			let source_reads = 0;
			let constructs = 0;
			let operations = 0;
			let method_receiver;
			let operation_receiver;
			let construct_receiver;
			const iterator = {
				next() { return { done: true, value: 1 }; }
			};
			const observed = {};
			Object.defineProperty(observed, kind === 'value' ? 'then' : Symbol.asyncIterator, {
				get() {
					const method = function (resolve) {
						method_receiver = this;
						if (kind === 'value') resolve(1);
						else return iterator;
					};
					Object.defineProperty(method, 'call', {
						value: () => expect.unreachable('startup must not consult method.call')
					});
					return method;
				}
			});
			const descriptor = {
				type: kind === 'value' ? 'async-value' : 'async-sequence',
				construct() { constructs++; construct_receiver = this; return tag`0`; },
				resolve() { operations++; operation_receiver = this; return tag``; },
				reject() { operations++; operation_receiver = this; return tag``; },
				next() { operations++; operation_receiver = this; return tag``; },
				complete() { operations++; operation_receiver = this; return tag``; },
				error() { operations++; operation_receiver = this; return tag``; }
			};
			for (const key of ['construct', 'resolve', 'reject', 'next', 'complete', 'error']) {
				Object.defineProperty(descriptor[key], 'call', {
					value: () => expect.unreachable(`${key} must not consult method.call`)
				});
			}
			Object.defineProperty(descriptor, 'source', {
				get() { source_reads++; return observed; }
			});
			const result = await unevalStream({}, (_value, js) => { tag = js; return descriptor; });
			for await (const _block of result.tail) {}
			// the source may be read any number of times; the receivers are the contract
			expect(constructs).toBe(1);
			expect(operations).toBe(1);
			expect(construct_receiver).toBe(descriptor);
			expect(operation_receiver).toBe(descriptor);
			expect(method_receiver).toBe(observed);
		}
	});

	test('ignores next call properties and invokes the cached callable while active', async () => {
		const controller = new AbortController();
		let call_reads = 0;
		let pulls = 0;
		const receivers = [];
		const argument_counts = [];
		const iterator = {};
		const next = null_prototype_callable(function () {
			pulls++;
			receivers.push(this);
			argument_counts.push(arguments.length);
			return pulls === 1 ? { done: false, value: 1 } : { done: true, value: 2 };
		});
		Object.defineProperty(next, 'call', {
			get() {
				call_reads++;
				controller.abort(0);
				return () => expect.unreachable('next.call delegate must not run');
			}
		});
		iterator.next = next;
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const outcome = await settled((async () => {
			const result = await unevalStream(source, undefined, { signal: controller.signal });
			for await (const _block of result.tail) {}
		})());
		expect(outcome.ok).toBe(true);
		expect(controller.signal.aborted).toBe(false);
		expect(call_reads).toBe(0);
		expect(pulls).toBe(2);
		expect(receivers).toEqual([iterator, iterator]);
		expect(argument_counts).toEqual([0, 0]);
	});

	test('invokes null-prototype return and cancel callables without waiting for a pull', async () => {
		const pending = Promise.withResolvers();
		const calls = [];
		let return_call_reads = 0;
		let cancel_call_reads = 0;
		const iterator = {};
		iterator.next = () => pending.promise;
		const return_method = null_prototype_callable(function () {
			calls.push(['return', this, arguments.length]);
			return { done: true };
		});
		Object.defineProperty(return_method, 'call', {
			get() {
				return_call_reads++;
				throw new Error('return.call must not be read');
			}
		});
		iterator.return = return_method;
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		let descriptor;
		const cancel = null_prototype_callable(function () {
			calls.push(['cancel', this, arguments.length]);
		});
		Object.defineProperty(cancel, 'call', {
			get() {
				cancel_call_reads++;
				throw new Error('cancel.call must not be read');
			}
		});
		const job = {};
		const result = await unevalStream(job, (value, js) => value === job && (descriptor = {
			type: 'async-sequence', source,
			construct: () => js`0`, next: () => js``, complete: () => js``, error: () => js``, cancel
		}));
		const next_result = settled(result.tail.next());
		expect(await result.tail.return()).toEqual({ done: true, value: undefined });
		expect(await next_result).toEqual({ ok: true, value: { done: true, value: undefined } });
		expect(return_call_reads).toBe(0);
		expect(cancel_call_reads).toBe(0);
		expect(calls.length).toBe(2);
		expect(calls.map(([name]) => name)).toEqual(['return', 'cancel']);
		expect(calls[0][1]).toBe(iterator);
		expect(calls[1][1]).toBe(descriptor);
		expect(calls.map(([, , count]) => count)).toEqual([0, 0]);
		pending.resolve({ done: true });
	});

	test('stops before a next body when next acquisition aborts', async () => {
		const controller = new AbortController();
		let body_calls = 0;
		let returns = 0;
		let cancels = 0;
		const iterator = {
			get next() {
				controller.abort(0);
				return null_prototype_callable(function () { body_calls++; return { done: true }; });
			},
			return() { returns++; return { done: true }; }
		};
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const job = {};
		expect(await rejected(unevalStream(job, (value, js) => value === job && ({
			type: 'async-sequence', source,
			construct: () => js`0`, next: () => js``, complete: () => js``, error: () => js``,
			cancel() { cancels++; }
		}), { signal: controller.signal }))).toBe(0);
		expect(body_calls).toBe(0);
		expect(returns).toBe(1);
		expect(cancels).toBe(1);
	});

	test('preserves a falsy abort raised inside a running next body', async () => {
		const controller = new AbortController();
		let pulls = 0;
		let returns = 0;
		let cancels = 0;
		const iterator = {
			next() {
				pulls++;
				controller.abort(0);
				return { done: false, value: 1 };
			},
			return() { returns++; return { done: true }; }
		};
		const source = { [Symbol.asyncIterator]() { return iterator; } };
		const job = {};
		expect(await rejected(unevalStream(job, (value, js) => value === job && ({
			type: 'async-sequence', source,
			construct: () => js`0`, next: () => js``, complete: () => js``, error: () => js``,
			cancel() { cancels++; }
		}), { signal: controller.signal }))).toBe(0);
		expect(pulls).toBe(1);
		expect(returns).toBe(1);
		expect(cancels).toBe(1);
	});

	/** Builds a sequence source whose pull-result getters count reads and may abort the session with reason 0. */
	function pull_case(results, controller) {
		const stats = { done_reads: 0, value_reads: 0, returns: 0, cancels: 0, pulls: 0 };
		const iterator = {
			next() {
				const spec = results[stats.pulls++];
				return {
					get done() {
						stats.done_reads++;
						if (spec.done === 'abort') controller.abort(0);
						return spec.done === 'abort' ? true : spec.done;
					},
					get value() {
						stats.value_reads++;
						if (spec.value === 'abort') controller.abort(0);
						return spec.value;
					}
				};
			},
			return() { stats.returns++; return { done: true }; }
		};
		return { stats, source: { [Symbol.asyncIterator]() { return iterator; } } };
	}

	const abort_cases = [
		{ initial: true, abort: 'done', results: [{ done: 'abort' }], value_reads: 0, pulls: 1 },
		{ initial: false, abort: 'done', results: [{ done: false, value: 1 }, { done: 'abort' }], value_reads: 1, pulls: 2 },
		{ initial: true, abort: 'value', results: [{ done: false, value: 'abort' }], value_reads: 1, pulls: 1 },
		{ initial: false, abort: 'value', results: [{ done: false, value: 1 }, { done: false, value: 'abort' }], value_reads: 2, pulls: 2 }
	];

	for (const current of abort_cases) {
		for (const native of [true, false]) {
			test(`${current.abort} getter abort on the ${current.initial ? 'initial' : 'resumed'} pull (${native ? 'native' : 'custom'})`, async () => {
				const controller = new AbortController();
				const fixture = pull_case(current.results, controller);
				const job = {};
				const stream = native
					? unevalStream(fixture.source, undefined, { signal: controller.signal })
					: unevalStream(job, (value, js) => value === job && ({
						type: 'async-sequence', source: fixture.source,
						construct: () => js`({events:[]})`,
						next: () => js``, complete: () => js``, error: () => js``,
						cancel() { fixture.stats.cancels++; }
					}), { signal: controller.signal });
				if (current.initial) {
					const outcome = await settled(stream);
					expect(outcome.ok).toBe(false);
					expect(outcome.reason).toBe(0);
				} else {
					const result = await stream;
					const outcome = await settled(result.tail.next());
					expect(outcome.ok).toBe(false);
					expect(outcome.reason).toBe(0);
				}
				// a value-getter abort is already running when it aborts, so its own read counts
				expect(fixture.stats.value_reads).toBe(current.value_reads);
				expect(fixture.stats.pulls).toBe(current.pulls);
				expect(fixture.stats.returns).toBe(1);
				expect(fixture.stats.cancels).toBe(native ? 0 : 1);
			});
		}
	}

	test('nonaborting done getters read the value once and preserve yield and return values', async () => {
		for (const native of [true, false]) {
			const fixture = pull_case([
				{ done: false, value: 'yield-value' },
				{ done: true, value: 'return-value' }
			]);
			const job = {};
			const result = native
				? await unevalStream(fixture.source, undefined)
				: await unevalStream(job, (value, js) => value === job && ({
					type: 'async-sequence', source: fixture.source,
					construct: () => js`({events:[]})`,
					next: (_reference, item) => js`${_reference.target}.events.push(${item})`,
					complete: (_reference, item) => js`(${item})`,
					error: () => js``
				}));
			expect(fixture.stats.done_reads).toBe(2);
			expect(fixture.stats.value_reads).toBe(2);
			expect(fixture.stats.pulls).toBe(2);
			if (native) expect(result.head.includes('(0,"yield-value")')).toBeTruthy();
			else expect(result.head.includes('.events.push("yield-value")')).toBeTruthy();
			const block = await result.tail.next();
			expect(block.done).toBe(false);
			if (native) expect(block.value.includes('(1,"return-value")')).toBeTruthy();
			else expect(block.value.includes('"return-value"')).toBeTruthy();
			expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		}
	});

	for (const phase of ['resolve', 'next', 'complete']) {
		test(`does not invoke ${phase} fallback after onerror aborts`, async () => {
			const controller = new AbortController();
			const gate = Promise.withResolvers();
			const reason = { phase, kind: 'abort from onerror' };
			const calls = [];
			let pulls = 0;
			let returns = 0;
			let cancels = 0;
			const sequence = phase !== 'resolve';
			const source = sequence ? {
				[Symbol.asyncIterator]() { return this; },
				next() { pulls++; return gate.promise; },
				return() { returns++; return { done: true }; }
			} : gate.promise;
			const value = {};
			const result = await unevalStream(value, (candidate, js) => candidate === value && ({
				type: sequence ? 'async-sequence' : 'async-value',
				source,
				construct: () => js`0`,
				resolve() { calls.push('resolve'); return null; },
				reject() { calls.push('fallback'); return js``; },
				next() { calls.push('next'); return null; },
				complete() { calls.push('complete'); return null; },
				error() { calls.push('fallback'); return js``; },
				cancel() { cancels++; }
			}), {
				signal: controller.signal,
				onerror(error) {
					calls.push('report');
					expect(error).toBeInstanceOf(TypeError);
					controller.abort(reason);
				}
			});
			const waiting = settled(result.tail.next());
			if (sequence) gate.resolve({ done: phase === 'complete', value: 1 });
			else gate.resolve(1);
			const outcome = await waiting;
			expect(outcome.ok).toBe(false);
			expect(outcome.reason).toBe(reason);
			expect(calls).toEqual([phase, 'report']);
			expect(cancels).toBe(1);
			expect(pulls).toBe(sequence ? 1 : 0);
			expect(returns).toBe(sequence ? 1 : 0);
		});
	}

	test('still invokes a valid fallback when onerror does not terminate the session', async () => {
		const gate = Promise.withResolvers();
		const calls = [];
		const value = {};
		const result = await unevalStream(value, (candidate, js) => candidate === value && ({
			type: 'async-value', source: gate.promise, construct: () => js`0`,
			resolve() { calls.push('resolve'); return null; },
			reject() { calls.push('fallback'); return js``; }
		}), { onerror: () => calls.push('report') });
		gate.resolve(1);
		expect((await result.tail.next()).done).toBe(false);
		expect(calls).toEqual(['resolve', 'report', 'fallback']);
		expect(await result.tail.next()).toEqual({ done: true, value: undefined });
	});

	test('does not queue an invalid captured outcome after onerror aborts', async () => {
		const controller = new AbortController();
		const gate = Promise.withResolvers();
		const reason = { kind: 'invalid outcome abort' };
		let operations = 0;
		let cancels = 0;
		const value = {};
		const result = await unevalStream(value, (candidate, js) => candidate === value && ({
			type: 'async-value', source: gate.promise, construct: () => js`0`,
			resolve() { operations++; return js``; },
			reject() { operations++; return js``; },
			cancel() { cancels++; }
		}), {
			signal: controller.signal,
			onerror(error) {
				expect(error.message).toMatch(/Cannot stringify a function/);
				controller.abort(reason);
			}
		});
		const waiting = settled(result.tail.next());
		gate.resolve(() => {});
		const outcome = await waiting;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe(reason);
		expect(operations).toBe(0);
		expect(cancels).toBe(1);
	});

	test('selects cleanup failures in source and operation order', async () => {
		const return_failure = { kind: 'return' };
		const cancel_failure = { kind: 'cancel' };
		const later_failure = { kind: 'later' };
		const reports = [];
		class Sequence {
			constructor(name) {
				this.name = name;
				this.source = {
					[Symbol.asyncIterator]: () => this.source,
					next: () => new Promise(() => {}),
					return: () => Promise.reject(name === 'first' ? return_failure : later_failure)
				};
			}
		}
		const values = [new Sequence('first'), new Sequence('second')];
		const result = await unevalStream(values, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
			if (value.name === 'first') throw cancel_failure;
		}), { onerror: (error) => reports.push(error) });
		expect(await rejected(result.tail.return())).toBe(return_failure);
		expect(reports).toEqual([cancel_failure, later_failure]);
	});

	for (const settlement of ['return-first', 'cancel-first']) {
		test(`selects acquisition-reentry cleanup failures by discovery order (${settlement})`, async () => {
			const outcome = Promise.withResolvers();
			const return_gate = Promise.withResolvers();
			const cancel_gate = Promise.withResolvers();
			const return_failure = { kind: 'return' };
			const cancel_failure = { kind: 'cancel' };
			const reports = [];
			const calls = [];
			const acquired = Promise.withResolvers();
			let reentrant_return;
			let result;
			let returns = 0;
			let first_cancels = 0;
			let second_cancels = 0;
			class Sequence {
				constructor(name) {
					this.name = name;
					this.source = {
						[Symbol.asyncIterator]: () => {
							calls.push(`acquire:${name}`);
							if (name === 'first') {
								reentrant_return = settled(result.tail.return());
								acquired.resolve();
							}
							return this.source;
						},
						next: () => new Promise(() => {}),
						return: () => {
							returns++;
							calls.push(`return:${name}`);
							return return_gate.promise;
						}
					};
				}
			}
			const values = [new Sequence('first'), new Sequence('second')];
			result = await unevalStream(outcome.promise, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
				calls.push(`cancel:${value.name}`);
				if (value.name === 'first') first_cancels++;
				else {
					second_cancels++;
					return cancel_gate.promise;
				}
			}), { onerror: (error) => reports.push(error) });
			const next = settled(result.tail.next());
			outcome.resolve(values);
			// the finite per-test timeout guards against cleanup deadlock
			await acquired.promise;
			expect(reentrant_return).toBeTruthy();
			expect(second_cancels).toBe(1);
			expect(returns).toBe(1);
			expect(first_cancels).toBe(1);
			if (settlement === 'return-first') {
				return_gate.reject(return_failure);
				await Promise.resolve();
				cancel_gate.reject(cancel_failure);
			} else {
				cancel_gate.reject(cancel_failure);
				await Promise.resolve();
				return_gate.reject(return_failure);
			}
			const next_result = await next;
			const return_result = await reentrant_return;
			expect(next_result.ok).toBe(false);
			expect(return_result.ok).toBe(false);
			expect(next_result.reason).toBe(return_failure);
			expect(return_result.reason).toBe(return_failure);
			expect(reports).toEqual([cancel_failure]);
			expect(returns).toBe(1);
			expect(first_cancels).toBe(1);
			expect(second_cancels).toBe(1);
			return_gate.resolve({ done: true });
			cancel_gate.resolve();
		});
	}

	test('preserves a falsy abort reason during iterator acquisition', async () => {
		const controller = new AbortController();
		const outcome = Promise.withResolvers();
		const return_failure = { kind: 'return' };
		const cancel_failure = { kind: 'cancel' };
		const reports = [];
		class Sequence {
			constructor(name) {
				this.name = name;
				this.source = {
					[Symbol.asyncIterator]: () => {
						if (name === 'first') controller.abort(0);
						return this.source;
					},
					next: () => new Promise(() => {}),
					return: () => Promise.reject(return_failure)
				};
			}
		}
		const values = [new Sequence('first'), new Sequence('second')];
		const result = await unevalStream(outcome.promise, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
			if (value.name === 'second') throw cancel_failure;
		}), { signal: controller.signal, onerror: (error) => reports.push(error) });
		const next = rejected(result.tail.next());
		outcome.resolve(values);
		expect(await next).toBe(0);
		expect(reports).toEqual([return_failure, cancel_failure]);
	});

	test('explicit cancellation reuses a failed-sequence close already in flight', async () => {
		const close_gate = Promise.withResolvers();
		let returns = 0;
		let cancels = 0;
		const iterable = {
			[Symbol.asyncIterator]() { return this; },
			next() { return { done: false, value: () => {} }; },
			return() { returns++; return close_gate.promise; }
		};
		class Sequence { constructor() { this.source = iterable; } }
		const value = new Sequence();
		const pending = new Promise(() => {});
		const result = await unevalStream([value, pending], (candidate, js) => candidate === value && sequence_descriptor(candidate, js, () => { cancels++; }));
		expect(returns).toBe(1);
		const returning = result.tail.return();
		expect(returns).toBe(1);
		expect(cancels).toBe(1);
		close_gate.resolve({ done: true });
		expect(await returning).toEqual({ done: true, value: undefined });
	});

	for (const phase of ['head', 'tail']) {
		test(`failed sequence close does not block ${phase} delivery`, async () => {
			const next_gate = Promise.withResolvers();
			const close_gate = Promise.withResolvers();
			const healthy = Promise.withResolvers();
			const reports = [];
			const close_failure = new Error(`late ${phase} close`);
			const iterable = {
				[Symbol.asyncIterator]() { return this; },
				next() { return next_gate.promise; },
				return() { return close_gate.promise; }
			};
			class Sequence { constructor() { this.source = iterable; } }
			const value = new Sequence();
			if (phase === 'head') {
				next_gate.resolve({ done: false, value: () => {} });
				healthy.resolve(1);
			}
			const result = await unevalStream([value, healthy.promise], (candidate, js) => candidate === value && sequence_descriptor(candidate, js), {
				onerror: (error) => reports.push(error)
			});
			if (phase === 'tail') {
				next_gate.resolve({ done: false, value: () => {} });
				healthy.resolve(1);
				expect((await result.tail.next()).done).toBe(false);
			}
			// The unserializable outcome is reported first; return failure is observed later.
			expect(reports.length).toBe(1);
			close_gate.reject(close_failure);
			await delay();
			expect(reports.length).toBe(2);
			expect(reports[1]).toBe(close_failure);
			expect(await result.tail.next()).toEqual({ done: true, value: undefined });
		});
	}

});
