import vm from 'node:vm';
import { describe, test, expect } from 'vitest';
import { RUNTIMES } from './stream-source.js';

describe('stream client runtime', () => {
	function buffered_iterator() {
		const context = vm.createContext({});
		const iterator = vm.runInContext(`(${RUNTIMES.f('s')})(g=>{globalThis.update=g})`, context);
		return { iterator, update: context.update };
	}

	async function rejected(promise, reason) {
		let caught;
		let did_reject = false;
		try {
			await promise;
		} catch (error) {
			did_reject = true;
			caught = error;
		}
		expect(did_reject).toBe(true);
		expect(caught).toBe(reason);
	}

	function plain(result) {
		return { done: result.done, value: result.value };
	}

	test('buffers yields and consumes a server return once', async () => {
		const { iterator, update } = buffered_iterator();
		update(0, 1);
		update(0, 2);
		update(1, 3);
		expect(plain(await iterator.next())).toEqual({ done: false, value: 1 });
		expect(plain(await iterator.next())).toEqual({ done: false, value: 2 });
		expect(plain(await iterator.next())).toEqual({ done: true, value: 3 });
		expect(plain(await iterator.next())).toEqual({ done: true, value: undefined });
		expect(plain(await iterator.next())).toEqual({ done: true, value: undefined });
	});

	test('buffers yields and consumes exact server errors once', async () => {
		for (const reason of [null, 0, false, '']) {
			const { iterator, update } = buffered_iterator();
			update(0, 1);
			update(2, reason);
			expect(plain(await iterator.next())).toEqual({ done: false, value: 1 });
			await rejected(iterator.next(), reason);
			expect(plain(await iterator.next())).toEqual({ done: true, value: undefined });
		}
	});

	test('settles concurrent reads FIFO with one terminal consumer', async () => {
		for (const terminal of [1, 2]) {
			const { iterator, update } = buffered_iterator();
			const reason = { terminal };
			const reads = [iterator.next(), iterator.next(), iterator.next(), iterator.next()];
			const failed = terminal === 2 ? rejected(reads[2], reason) : undefined;
			update(0, 'a');
			update(0, 'b');
			update(terminal, reason);
			expect(plain(await reads[0])).toEqual({ done: false, value: 'a' });
			expect(plain(await reads[1])).toEqual({ done: false, value: 'b' });
			if (terminal === 1) expect(plain(await reads[2])).toEqual({ done: true, value: reason });
			else await failed;
			expect(plain(await reads[3])).toEqual({ done: true, value: undefined });
		}
	});

	test('local return discards all server state and settles pending reads without its value', async () => {
		const { iterator, update } = buffered_iterator();
		update(0, 'buffered');
		update(1, 'server result');
		expect(plain(await iterator.return('local result'))).toEqual({
			done: true,
			value: 'local result'
		});
		update(0, 'ignored');
		update(1, 'ignored');
		expect(plain(await iterator.next())).toEqual({ done: true, value: undefined });
		expect(plain(await iterator.return('again'))).toEqual({ done: true, value: 'again' });

		const waiting = buffered_iterator();
		const reads = [waiting.iterator.next(), waiting.iterator.next()];
		expect(plain(await waiting.iterator.return('stop'))).toEqual({ done: true, value: 'stop' });
		for (const read of reads) expect(plain(await read)).toEqual({ done: true, value: undefined });
	});

	test('local throw discards completed or failed server state and rejects pending reads', async () => {
		for (const terminal of [1, 2]) {
			const { iterator, update } = buffered_iterator();
			update(0, 'buffered');
			update(terminal, 'server terminal');
			const local = { terminal };
			await rejected(iterator.throw(local), local);
			update(0, 'ignored');
			update(terminal, 'ignored');
			expect(plain(await iterator.next())).toEqual({ done: true, value: undefined });
		}

		const { iterator, update } = buffered_iterator();
		const reads = [iterator.next(), iterator.next()];
		const local = 0;
		const failures = reads.map((read) => rejected(read, local));
		await rejected(iterator.throw(local), local);
		await Promise.all(failures);
		update(0, 'ignored');
		expect(plain(await iterator.next())).toEqual({ done: true, value: undefined });
		await rejected(iterator.throw(false), false);
	});
});
