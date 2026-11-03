import { expect, test } from 'vitest';
import { DevalueError, Session } from '../src/index.js';
import { client } from './helpers/stream.js';

test('has only the public API', () => {
	const names = Object.getOwnPropertyNames(Session.prototype).sort();
	expect(names).toEqual(['changed', 'constructor', 'end', 'flush', 'id', 'pending', 'uneval']);
});

test('passes each value to receive, sharing references with earlier values', () => {
	const c = client();
	const session = new Session({ id: 'a' });
	const shared = { name: 'shared' };

	const first = c.head(session.uneval({ shared }));
	const second = c.head(session.uneval(['later', shared]));

	expect(first).toEqual({ shared: { name: 'shared' } });
	expect(second[1]).toBe(first.shared);
	expect(c.receive_calls.map(([id]) => id)).toEqual(['a', 'a']);
	expect(c.done_ids).toEqual([]);
});

test('settles promises when flushed, and only then', async () => {
	const c = client();
	const session = new Session({ id: 'a' });
	const { promise, resolve } = Promise.withResolvers();

	const value = c.head(session.uneval({ promise }));
	expect(session.pending).toBe(1);
	expect(session.flush()).toEqual({ code: '', errors: [] });

	resolve({ done: true });
	await session.changed();
	expect(session.pending).toBe(1);

	const { code, errors } = session.flush();
	expect(errors).toEqual([]);
	expect(session.pending).toBe(0);
	c.block(code);
	expect(await value.promise).toEqual({ done: true });
	expect(session.flush().code).toBe('');
});

test('flushes promises that had already settled after a microtask', async () => {
	const c = client();
	const session = new Session({ id: 'a' });

	const value = c.head(session.uneval({ promise: Promise.resolve(1) }));
	await null;

	c.block(session.flush().code);
	expect(await value.promise).toBe(1);
});

test('resolved values can refer to earlier values, and contain new promises', async () => {
	const c = client();
	const session = new Session({ id: 'a' });
	const shared = {};
	const inner = Promise.withResolvers();
	const outer = Promise.withResolvers();

	const value = c.head(session.uneval({ shared, outer: outer.promise }));
	outer.resolve({ shared, inner: inner.promise });
	await session.changed();
	c.block(session.flush().code);
	expect(session.pending).toBe(1);

	const resolved = await value.outer;
	expect(resolved.shared).toBe(value.shared);

	inner.resolve('inner');
	await session.changed();
	c.block(session.flush().code);
	expect(await resolved.inner).toBe('inner');
});

test('changed can be abandoned without losing anything', async () => {
	const c = client();
	const session = new Session({ id: 'a' });
	const { promise, resolve } = Promise.withResolvers();

	const value = c.head(session.uneval({ promise }));
	await Promise.race([session.changed(), Promise.resolve()]);

	resolve(1);
	await session.changed();
	// a second call resolves straight away, since there's something to flush
	await session.changed();

	c.block(session.flush().code);
	expect(await value.promise).toBe(1);
});

test('throws for a value that cannot be serialized, without recording anything', () => {
	const c = client();
	const session = new Session({ id: 'a' });
	const shared = {};

	expect(() => session.uneval({ shared, fn: () => {} })).toThrow(DevalueError);
	expect(session.pending).toBe(0);

	const first = c.head(session.uneval({ shared }));
	const second = c.head(session.uneval([shared]));
	expect(second[0]).toBe(first.shared);
});

test('reports promises that resolve to something that cannot be serialized', async () => {
	const c = client();
	const session = new Session({ id: 'a' });
	const bad = Promise.resolve({ fn: () => {} });

	const value = c.head(session.uneval({ bad, good: Promise.resolve('good') }));
	await session.changed();

	const { code, errors } = session.flush();
	expect(errors).toHaveLength(1);
	expect(errors[0].promise).toBe(bad);
	expect(errors[0].error).toBeInstanceOf(DevalueError);

	c.block(code);
	expect(await value.good).toBe('good');
	await expect(value.bad).rejects.toThrow('failed to serialize');
	expect(session.pending).toBe(0);
});

test('waits for an asynchronous transformError', async () => {
	const c = client();
	const { promise, resolve } = Promise.withResolvers();
	const session = new Session({ id: 'a', transformError: () => promise });

	const value = c.head(session.uneval({ p: Promise.reject(new Error('secret')) }));
	await new Promise((fulfil) => setTimeout(fulfil));
	expect(session.flush().code).toBe('');
	expect(session.pending).toBe(1);

	resolve({ message: 'public' });
	await session.changed();
	c.block(session.flush().code);
	await expect(value.p).rejects.toEqual({ message: 'public' });
});

test('end rejects pending promises and ends the stream', async () => {
	const c = client();
	const session = new Session({ id: 'a' });

	const value = c.head(session.uneval({ never: new Promise(() => {}) }));
	c.block(session.end());

	await expect(value.never).rejects.toThrow('stream aborted');
	expect(c.done_ids).toEqual(['a']);
	expect(() => session.uneval(1)).toThrow('the session has ended');
	expect(() => session.end()).toThrow('the session has ended');
	await session.changed();
	expect(session.flush()).toEqual({ code: '', errors: [] });
});

test('end without pending promises ends the stream', () => {
	const c = client();
	const session = new Session({ id: 'a' });

	c.head(session.uneval(1));
	c.block(session.end());
	expect(c.done_ids).toEqual(['a']);
});

test('works before install and with a custom scope', () => {
	const c = client({}, { install: false });
	const session = new Session({ id: 'a', scope: 'globalThis.__custom' });

	c.block(session.uneval({ a: 1 }));
	c.block(session.uneval({ b: 2 }));
	c.install({ key: '__custom' });

	expect(c.receive_calls).toEqual([
		['a', { a: 1 }],
		['a', { b: 2 }]
	]);
});

test('has a random id by default', () => {
	expect(new Session().id).toMatch(/^[a-z0-9]+$/);
	expect(new Session().id).not.toBe(new Session().id);
});
