import { unflatten } from "./parse.js";
import { stringify } from "./stringify.js";

/**
 * Checks if a value is a Promise-like object
 * @param {unknown} value The value to check
 * @returns {value is Promise<unknown>} True if the value is a Promise-like object, false otherwise
 */
function isPromise(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * Checks if a value is an AsyncIterable object
 * @param {unknown} value The value to check
 * @returns {value is AsyncIterable<unknown>} True if the value is an AsyncIterable, false otherwise
 */
function isAsyncIterable(value) {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}
const PROMISE_STATUS_FULFILLED = 0;
const PROMISE_STATUS_REJECTED = 1;

const ASYNC_ITERABLE_STATUS_YIELD = 0;
const ASYNC_ITERABLE_STATUS_ERROR = 1;
const ASYNC_ITERABLE_STATUS_RETURN = 2;

/**
 * Merges multiple async iterables into a single async iterable that yields values in the order they resolve
 * @template T
 * @returns {{
 *   add: (iterable: AsyncIterable<T>) => void,
 *   [Symbol.asyncIterator]: () => AsyncIterator<T>
 * }}
 */
function asyncIterableMerge() {
  /** @type {Set<AsyncIterable<T>>} */
  const pendingIterables = new Set();
  /** @type {Set<{iterator: AsyncIterator<T>, next: Promise<IteratorResult<T, any>>}>} */
  const activeIterators = new Set();
  
  let running = false;
  let frozen = false;

  return {
    add(iterable) {
      if (frozen) {
        throw new Error("Cannot add to frozen async iterable");
      }
      
      if (!running) {
        pendingIterables.add(iterable);
        return;
      }

      // If we're already iterating, initialize the iterator immediately
      const iterator = iterable[Symbol.asyncIterator]();
      
      activeIterators.add({ iterator, next: iterator.next() });
    },

    async *[Symbol.asyncIterator]() {
      try {
        running = true;

        // Initialize any pending iterables
        for (const iterable of pendingIterables) {
          const iterator = iterable[Symbol.asyncIterator]();
          activeIterators.add({ iterator, next: iterator.next() });
        }
        pendingIterables.clear();

        while (activeIterators.size > 0) {
          const [entry, res] = await Promise.race(
            Array.from(activeIterators).map(
              async (it) => /** @type {const} */ ([it, await it.next])
            )
          );

          activeIterators.delete(entry);
          if (!res.done) {
            yield res.value;
            activeIterators.add({
              iterator: entry.iterator,
              next: entry.iterator.next(),
            });
          }
        }
      } finally {
        // Clean up all iterators
        await Promise.allSettled(
          Array.from(activeIterators).map((it) => it.iterator.return?.())
        );
        activeIterators.clear();
        pendingIterables.clear();
        frozen = true;
        running = false;
      }
    },
  };
}

/**
 * Streams a value into a JSON string that can be parsed with `devalue.parse`
 * @param {unknown} value The value to stream
 * @param {object} [options]
 * @param {Record<string, (value: any) => any>} [options.revivers] Custom revivers to handle special object types
 * @param {(error: unknown) => unknown} [options.coerceError] Function to transform unknown errors to a known error. The known error must be handled by the reviver.
 * @returns {AsyncIterable<string>} An async iterable that yields the streamed value as JSON chunks
 */
export async function* stringifyAsync(value, options = {}) {
  let counter = 0;

  /** @type {ReturnType<typeof asyncIterableMerge<[number, number, string]>>} */
  const mergedIterables = asyncIterableMerge();

  /**
   * Registers an async iterable callback and returns its index
   * @param {(idx: number) => AsyncIterable<[number, string]>} callback The async iterable callback function
   * @returns {number} The index assigned to this callback
   */
  function registerAsync(callback) {
    const idx = ++counter;

    const iterable = callback(idx);

    mergedIterables.add(
      (async function* () {
        for await (const item of iterable) {
          yield [idx, ...item];
        }
      })()
    );

    return idx;
  }

  /** @type {Record<string, (value: any) => any>} */
  const revivers = {
    ...options.revivers,
    Promise: (v) => {
      if (!isPromise(v)) {
        return false;
      }
      v.catch(() => {
        // prevent unhandled promise rejection
      });
      return registerAsync(async function* (idx) {
        try {
          const next = await v;
          yield [PROMISE_STATUS_FULFILLED, stringify(next, revivers)];
        } catch (cause) {
          yield [PROMISE_STATUS_REJECTED, safeCause(cause)];
        }
      });
    },
    AsyncIterable: (v) => {
      if (!isAsyncIterable(v)) {
        return false;
      }
      return registerAsync(async function* (idx) {
        const iterator = v[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              yield [
                ASYNC_ITERABLE_STATUS_RETURN,
                stringify(next.value, revivers),
              ];
              break;
            }
            yield [
              ASYNC_ITERABLE_STATUS_YIELD,
              stringify(next.value, revivers),
            ];
          }
        } catch (cause) {
          yield [ASYNC_ITERABLE_STATUS_ERROR, safeCause(cause)];
        } finally {
          await iterator.return?.();
        }
      });
    },
  };

  /** @param {unknown} cause The error cause to safely stringify - prevents interrupting full stream when error is unregistered */
  function safeCause(cause) {
    try {
      return stringify(cause, revivers);
    } catch (err) {
      if (!options.coerceError) {
        throw err;
      }
      return stringify(options.coerceError(cause), revivers);
    }
  }

  yield stringify(value, revivers) + "\n";

  for await (const item of mergedIterables) {
    yield "[" + item.join(",") + "]\n";
  }
}

/**
 * Asserts that a value is a number
 * @param {unknown} value The value to assert
 * @returns {asserts value is number} Type assertion that value is a number
 */
function assertNumber(value) {
  if (typeof value !== "number") {
    throw new Error(`Expected number, got ${typeof value}`);
  }
}
/**
 * Creates a deferred promise that can be resolved or rejected externally
 * @template T The type of the promise value
 * @returns {{
 *   promise: Promise<T>,
 *   resolve: (value: T | PromiseLike<T>) => void,
 *   reject: (reason?: unknown) => void
 * }}
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Parse an async iterable value serialized with `devalue.stringify`
 * @param {AsyncIterable<string>} value
 * @param {Record<string, (value: any) => any>} [revivers]

 * @returns {Promise<unknown>}
 */
export async function parseAsync(value, revivers) {
  const iterator = value[Symbol.asyncIterator]();
  /** @type {Map<number, (v: [number, unknown] | Error) => void>} */
  const enqueueMap = new Map();

  /**
   * @param {number} id
   * @returns {AsyncIterable<[number, unknown]>}
   */
  async function* registerAsync(id) {
    /** @type {Array<Error | [number, unknown]>} */
    const buffer = [];

    let deferred = createDeferred();

    enqueueMap.set(id, (v) => {
      buffer.push(v);
      deferred.resolve();
    });
    try {
      while (true) {
        await deferred.promise;
        deferred = createDeferred();

        while (buffer.length) {
          const value = buffer.shift();
          if (value instanceof Error) {
            throw value;
          }
          yield value;
        }
      }
    } finally {
      enqueueMap.delete(id);
    }
  }

  /** @type {Record<string, (value: any) => any>} */
  const asyncRevivers = {
    ...revivers,
    Promise: async (idx) => {
      const iterable = registerAsync(idx);

      for await (const item of iterable) {
        const [status, value] = item;
        switch (status) {
          case PROMISE_STATUS_FULFILLED:
            return value;
          case PROMISE_STATUS_REJECTED:
            throw value;
          default:
            throw new Error(`Unknown promise status: ${status}`);
        }
      }
    },
    AsyncIterable: async function* (idx) {
      const iterable = registerAsync(idx);

      for await (const item of iterable) {
        const [status, value] = item;
        switch (status) {
          case ASYNC_ITERABLE_STATUS_YIELD:
            yield value;
            break;
          case ASYNC_ITERABLE_STATUS_RETURN:
            return value;
          case ASYNC_ITERABLE_STATUS_ERROR:
            throw value;
        }
      }
    },
  };

  // will contain the head of the async iterable
  const head = await iterator.next();
  const headValue = unflatten(JSON.parse(head.value), asyncRevivers);

  if (!head.done) {
    (async () => {
      while (true) {
        const result = await iterator.next();
        if (result.done) break;

        const [idx, status, flattened] = JSON.parse(result.value);

        assertNumber(idx);
        assertNumber(status);

        enqueueMap.get(idx)?.([status, unflatten(flattened, asyncRevivers)]);
      }
      // if we get here, we've finished the stream, let's go through all the enqueue map and enqueue a stream interrupt error
      // this will only happen if receiving a malformatted stream
      for (const [_, enqueue] of enqueueMap) {
        enqueue(new Error("Stream interrupted: malformed stream"));
      }
    })().catch((cause) => {
      // go through all the asyncMap and enqueue the error
      for (const [_, enqueue] of enqueueMap) {
        enqueue(
          cause instanceof Error
            ? cause
            : new Error(
                "Stream interrupted",
                // @ts-ignore this is fine
                { cause }
              )
        );
      }
    });
  }

  return headValue;
}

/**
 * Creates a ReadableStream from an AsyncIterable.
 *
 * @template T
 * @param {AsyncIterable<T>} iterable - The source AsyncIterable to stream from
 * @returns {ReadableStream<T>} A ReadableStream that yields values from the AsyncIterable
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

/**
 * Converts a ReadableStream to an AsyncIterable.
 *
 * @template T
 * @param {ReadableStream<T>} stream - The ReadableStream to convert
 * @returns {AsyncIterable<T>} An AsyncIterable that yields values from the stream
 */
export async function* asyncIterableFrom(stream) {
  const reader = stream.getReader();

  try {
    while (true) {
      const res = await reader.read();

      if (res.done) {
        return res.value;
      }

      yield res.value;
    }
  } finally {
    reader.releaseLock();
    await reader.cancel()
  }
}
