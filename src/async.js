import { stringify } from "./stringify.js";

/**
 * Checks if a value is a Promise-like object
 * @param {unknown} value The value to check
 * @returns {value is Promise<unknown>} True if the value is a Promise-like object, false otherwise
 */
function isPromise(value) {
	return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

const PROMISE_STATUS_FULFILLED = 0;
const PROMISE_STATUS_REJECTED = 1;

/**
 * Streams a value into a JSON string that can be parsed with `devalue.parse`
 * @param {unknown} value The value to stream
 * @param {Record<string, (value: any) => any>} [revivers] Optional revivers to handle custom types
 * @returns {AsyncGenerator<unknown>} An async generator that yields the streamed value
 */
export async function* stringifyStream(value, revivers = {}) {
	let counter = 0;

	/** @type {Set<{iterator: AsyncIterator<unknown>, nextPromise: Promise<IteratorResult<unknown, unknown>>}>} */
	const buffer = new Set();

	/**
	 * Registers an async iterable callback and returns its index
	 * @param {(idx: number) => AsyncIterable<unknown>} callback The async iterable callback function
	 * @returns {number} The index assigned to this callback
	 */
	function registerAsyncIterable(callback) {
		const idx = counter++;

		const iterator = callback(idx)[Symbol.asyncIterator]();

		const nextPromise = iterator.next();

		nextPromise.catch(() => {
			// prevent unhandled promise rejection
		});
		buffer.add({
			iterator,
			nextPromise,
		});

		return idx;
	}

	/**
	 * Recursively stringifies a value, handling promises specially
	 * @param {unknown} v The value to stringify
	 * @returns {string} The stringified value
	 */
	function recurse(v) {
		return stringify(v, {
			...revivers,
			Promise: (v) => {
				if (!isPromise(v)) {
					return false;
				}
				return [registerAsyncIterable(async function* () {
					// console.log('registerAsyncIterable', v);
					v.catch(() => {
						// prevent unhandled promise rejection
					});
					try {
						const next = await v;
						return [PROMISE_STATUS_FULFILLED, next];
					} catch (e) {
						return [PROMISE_STATUS_REJECTED, e];
					}
				})]
			},
		});
	}
	try {
		yield recurse(value);


		while (buffer.size) {
			// Race all iterators to get the next value from any of them
			const [entry, res] = await Promise.race(
				Array.from(buffer).map(async (it) => 
					/** @type {const} */ ([it, await it.nextPromise]),
				),
			);

			yield recurse(res.value);


			// Remove current iterator and re-add if not done
			buffer.delete(entry);
			if (!res.done) {
				entry.nextPromise = entry.iterator.next();
				buffer.add(entry);
			}
		}

	} finally {
		// Return all iterators
		await Promise.allSettled(Array.from(buffer).map(it => it.iterator.return()));
	}
}


export function parseStream() {
    
}

/**
 * Creates a ReadableStream from an AsyncIterable.
 * 
 * @param {AsyncIterable<unknown>} iterable The source AsyncIterable to stream from
 * @returns {ReadableStream} A ReadableStream that yields values from the AsyncIterable
 */
export function readableStreamFrom(iterable) {
	const iterator = iterable[Symbol.asyncIterator]();

	return new ReadableStream({
		async cancel() {
			await iterator.return?.();
		},

		async pull(controller) {
			const result = await iterator.next();

			if (result.done) {
				controller.close();
				return;
			}

			controller.enqueue(result.value);
		},
	});
}
  