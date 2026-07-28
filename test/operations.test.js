import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import {
	stringify,
	stringifyAsync,
	defaultOperations,
	filterArrayIndices,
	parse
} from '../index.js';

globalThis.Temporal ??= (await import('@js-temporal/polyfill')).Temporal;

/**
 * @param {string} name
 * @param {(test: import('uvu').Test) => void} fn
 */
function suite(name, fn) {
	const test = uvu.suite(name);
	fn(test);
	test.run();
}

// ---------------------------------------------------------------------------
// Custom operations: basic plumbing
// ---------------------------------------------------------------------------

suite('operations option', (test) => {
	test('partial overrides merge over defaults', () => {
		let calls = 0;

		const result = stringify(
			{ a: 1, b: [2, 3] },
			undefined,
			{
				operations: {
					get(value, key) {
						calls += 1;
						return value[key];
					}
				}
			}
		);

		assert.equal(result, stringify({ a: 1, b: [2, 3] }));
		// a, b, b[0], b[1]
		assert.equal(calls, 4);
	});

	test('explicitly-undefined overrides fall back to defaults', () => {
		// programmatically-built override objects often carry undefined members
		const result = stringify(
			{ a: 1, date: new Date(1700000000000) },
			undefined,
			{
				operations: {
					get: undefined,
					toISOString: undefined,
					tagOf: (value) => defaultOperations.tagOf(value)
				}
			}
		);

		assert.equal(result, stringify({ a: 1, date: new Date(1700000000000) }));
	});

	test('nullish overrides fall back to defaults', () => {
		const value = { a: 1, date: new Date(1700000000000) };

		const result = stringify(value, undefined, {
			operations: {
				get: undefined,
				// @ts-expect-error null is not a valid override, but coalesces
				toISOString: null,
				tagOf: (thing) => defaultOperations.tagOf(thing)
			}
		});

		assert.equal(result, stringify(value));
	});

	test('inherited operation members are picked up', () => {
		// an operations object need not own its members — e.g. a class instance
		class Operations {
			/** @param {any} value */
			toISOString(value) {
				return `custom:${value.getTime()}`;
			}
		}

		const result = stringify(new Date(1700000000000), undefined, {
			operations: new Operations()
		});

		assert.equal(result, '[["Date","custom:1700000000000"]]');
	});

	test('defaultOperations and shapeOf sentinels are frozen', () => {
		assert.ok(Object.isFrozen(defaultOperations));
		assert.ok(Object.isFrozen(defaultOperations.shapeOf(new Map())));
		assert.ok(
			Object.isFrozen(defaultOperations.shapeOf({ [Symbol('key')]: 1 }))
		);
	});

	test('defaultOperations is exported and delegable', () => {
		const result = stringify(new Map([['k', 'v']]), undefined, {
			operations: {
				entriesOf: (value) => defaultOperations.entriesOf(value)
			}
		});

		assert.equal(result, stringify(new Map([['k', 'v']])));
	});

	test('identify controls deduplication and cycle detection', () => {
		// Two distinct wrapper objects representing the same logical value
		// (the handle scenario) must serialize as one deduplicated entry.
		class Wrapper {
			constructor(inner) {
				this.inner = inner;
			}
		}

		const shared = { x: 1 };
		const a = new Wrapper(shared);
		const b = new Wrapper(shared);

		/** @type {import('../src/types.js').StringifyOperations['shapeOf']} */
		const shapeOf = (value) =>
			value instanceof Wrapper
				? defaultOperations.shapeOf(value.inner)
				: defaultOperations.shapeOf(value);

		const result = stringify([a, b], undefined, {
			operations: {
				identify: (value) => (value instanceof Wrapper ? value.inner : value),
				tagOf: (value) => (value instanceof Wrapper ? 'Object' : defaultOperations.tagOf(value)),
				shapeOf,
				get: (value, key) =>
					value instanceof Wrapper ? value.inner[key] : value[key]
			}
		});

		assert.equal(result, stringify([shared, shared]));
		assert.equal(parse(result)[0], parse(result)[1]);
	});
});

// ---------------------------------------------------------------------------
// Side-effect-free serialization
// ---------------------------------------------------------------------------

suite('side-effect-free operations', (test) => {
	test('toISOString override avoids patched Date.prototype.toISOString', () => {
		const original = Date.prototype.toISOString;
		let patched_calls = 0;
		// eslint-disable-next-line no-extend-native
		Date.prototype.toISOString = function () {
			patched_calls += 1;
			return original.call(this);
		};

		try {
			const date = new Date(1700000000000);

			// default ops call the (patched) prototype method
			stringify(date);
			assert.equal(patched_calls, 1);

			// hardened ops use a captured intrinsic
			const result = stringify(date, undefined, {
				operations: {
					toISOString: (value) => original.call(value)
				}
			});

			assert.equal(patched_calls, 1); // unchanged
			assert.equal(result, `[["Date","2023-11-14T22:13:20.000Z"]]`);
		} finally {
			// eslint-disable-next-line no-extend-native
			Date.prototype.toISOString = original;
		}
	});

	test('entriesOf/valuesOf overrides avoid patched Symbol.iterator', () => {
		const map_entries = Map.prototype.entries;
		const set_values = Set.prototype.values;
		const map_iterator = Map.prototype[Symbol.iterator];
		const set_iterator = Set.prototype[Symbol.iterator];
		let patched_calls = 0;

		Map.prototype[Symbol.iterator] = function () {
			patched_calls += 1;
			return map_entries.call(this);
		};
		Set.prototype[Symbol.iterator] = function () {
			patched_calls += 1;
			return set_values.call(this);
		};

		try {
			const value = { map: new Map([[1, 2]]), set: new Set([3]) };

			const result = stringify(value, undefined, {
				operations: {
					entriesOf: (map) => map_entries.call(map),
					valuesOf: (set) => set_values.call(set)
				}
			});

			assert.equal(patched_calls, 0);
			assert.equal(result, stringify({ map: new Map([[1, 2]]), set: new Set([3]) }));
		} finally {
			Map.prototype[Symbol.iterator] = map_iterator;
			Set.prototype[Symbol.iterator] = set_iterator;
		}
	});

	test('tagOf override is not fooled by Symbol.toStringTag getters', () => {
		let getter_calls = 0;

		const sneaky = {};
		Object.defineProperty(sneaky, Symbol.toStringTag, {
			get() {
				getter_calls += 1;
				return 'Date';
			}
		});

		// default ops consult Object.prototype.toString, which reads the
		// (getter-defined) Symbol.toStringTag — executing user code and
		// misclassifying the object
		assert.throws(() => stringify(sneaky));
		assert.ok(getter_calls > 0);

		getter_calls = 0;

		// hardened ops use brand checks — here simplified to "trust nothing"
		const result = stringify(sneaky, undefined, {
			operations: {
				tagOf: (value) => {
					if (value instanceof Date) return 'Date';
					if (Array.isArray(value)) return 'Array';
					return 'Object';
				}
			}
		});

		assert.equal(getter_calls, 0);
		assert.equal(result, '[{}]');
	});

	test('get override reads through descriptors without invoking getters', () => {
		let getter_calls = 0;

		const thing = {
			plain: 'data',
			get computed() {
				getter_calls += 1;
				return 'side effect!';
			}
		};

		/** @type {import('../src/types.js').StringifyOperations['get']} */
		const get = (value, key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor && (descriptor.get || descriptor.set)) {
				throw new Error(`refusing to invoke getter for "${key}"`);
			}
			return descriptor ? descriptor.value : undefined;
		};

		assert.throws(
			() => stringify(thing, undefined, { operations: { get } }),
			/refusing to invoke getter for "computed"/
		);
		assert.equal(getter_calls, 0);

		// default behavior does invoke the getter
		stringify(thing);
		assert.equal(getter_calls, 1);
	});

	test('isThenable override avoids .then getter execution', () => {
		let then_reads = 0;

		const trap = {
			marker: true
		};
		Object.defineProperty(trap, 'then', {
			get() {
				then_reads += 1;
				return undefined;
			}
		});

		stringify(trap, undefined, {
			operations: {
				isThenable: (value) => value instanceof Promise,
				shapeOf: (value) => ({
					kind: 'plain',
					keys: Object.keys(value)
				})
			}
		});

		assert.equal(then_reads, 0);
	});
});

// ---------------------------------------------------------------------------
// Foreign-runtime (handle-based) serialization
// ---------------------------------------------------------------------------

// A stand-in for a VM value handle (e.g. a QuickJS-in-WASM JSValueHandle):
// the serializer never touches the underlying value directly — every
// introspection goes through the operations implementation below.
class Handle {
	/** @param {any} value */
	constructor(value) {
		this.value = value;
	}
}

/** @param {any} value */
const h = (value) => new Handle(value);

/** @param {Handle} handle */
const raw = (handle) => /** @type {Handle} */ (handle).value;

/**
 * A complete operations implementation over Handle-wrapped values. Mirrors
 * how a real foreign-runtime integration would work: `identify` unwraps to
 * the underlying identity, every extraction returns host values, and every
 * recursive value (array elements, map entries, buffers, …) is re-wrapped
 * in a fresh Handle to prove that deduplication does not depend on handle
 * identity.
 *
 * @type {import('../src/types.js').StringifyOperations}
 */
const handle_operations = {
	identify: (handle) => raw(handle),
	typeOf: (handle) => {
		const value = raw(handle);
		return value === null ? 'null' : typeof value;
	},
	toPrimitive: (handle) => raw(handle),
	tagOf: (handle) => defaultOperations.tagOf(raw(handle)),
	isThenable: (handle) => typeof raw(handle).then === 'function',
	toPromise: (handle) => Promise.resolve(raw(handle)).then(h),
	unbox: (handle) => h(raw(handle).valueOf()),
	toISOString: (handle) => defaultOperations.toISOString(raw(handle)),
	toStringValue: (handle) => raw(handle).toString(),
	regExpInfo: (handle) => defaultOperations.regExpInfo(raw(handle)),
	valuesOf: (handle) => [...raw(handle)].map(h),
	entriesOf: (handle) => [...raw(handle)].map(([k, v]) => [h(k), h(v)]),
	viewInfo: (handle) => {
		const info = defaultOperations.viewInfo(raw(handle));
		return { ...info, buffer: h(info.buffer) };
	},
	toArrayBuffer: (handle) => raw(handle),
	lengthOf: (handle) => raw(handle).length,
	hasOwn: (handle, index) => Object.hasOwn(raw(handle), index),
	indicesOf: (handle) => defaultOperations.indicesOf(raw(handle)),
	shapeOf: (handle) => defaultOperations.shapeOf(raw(handle)),
	get: (handle, key) => h(raw(handle)[key])
};

suite('handle-based operations', (test) => {
	/** @param {any} value */
	function assert_parity(value) {
		assert.equal(
			stringify(h(value), undefined, { operations: handle_operations }),
			stringify(value)
		);
	}

	test('primitives', () => {
		assert_parity(42);
		assert_parity(-0);
		assert_parity(NaN);
		assert_parity(Infinity);
		assert_parity('hello');
		assert_parity(true);
		assert_parity(null);
		assert_parity(undefined);
		assert_parity(123n);
	});

	test('objects, arrays and special types', () => {
		assert_parity({ a: 1, nested: { b: [2, 3] } });
		assert_parity([1, 'two', { three: 3 }]);
		assert_parity(new Date(1700000000000));
		assert_parity(/ab+c/gi);
		assert_parity(new Map([['k', { v: 1 }]]));
		assert_parity(new Set([1, 2, 3]));
		assert_parity(new URL('https://example.com/path?q=1'));
		// eslint-disable-next-line no-sparse-arrays
		assert_parity([1, , 3]);
		assert_parity(Object.assign(Object.create(null), { x: 1 }));
		assert_parity(new Number(42));
	});

	test('typed arrays and buffers', () => {
		const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
		assert_parity(buffer);
		assert_parity(new Uint8Array(buffer));
		assert_parity(new Int16Array(buffer, 2, 2)); // subarray
		assert_parity(new DataView(buffer, 1, 4));
	});

	test('repeated references deduplicate via identify despite distinct handles', () => {
		const shared = { x: 1 };
		const value = { first: shared, second: shared };

		// every property access creates a *fresh* Handle, so without
		// identify-based keying the two handles would serialize twice
		const result = stringify(h(value), undefined, { operations: handle_operations });

		assert.equal(result, stringify(value));

		const parsed = parse(result);
		assert.equal(parsed.first, parsed.second);
	});

	test('cyclic values', () => {
		/** @type {any} */
		const cyclic = { name: 'cycle' };
		cyclic.self = cyclic;

		const result = stringify(h(cyclic), undefined, { operations: handle_operations });

		assert.equal(result, stringify(cyclic));

		const parsed = parse(result);
		assert.equal(parsed.self, parsed);
	});

	test('reducers receive the handle, not the raw value', () => {
		class Custom {
			constructor(inner) {
				this.inner = inner;
			}
		}

		const result = stringify(h(new Custom('yes')), {
			Custom: (handle) =>
				handle instanceof Handle && raw(handle) instanceof Custom
					? h(raw(handle).inner)
					: false
		}, { operations: handle_operations });

		assert.equal(result, '[["Custom",1],"yes"]');
	});

	test('async: thenables resolve through toPromise', async () => {
		const value = { result: Promise.resolve({ deep: Promise.resolve(42) }) };

		const [expected, actual] = await Promise.all([
			stringifyAsync(value),
			stringifyAsync(h(value), undefined, { operations: handle_operations })
		]);

		assert.equal(actual, expected);
	});

	test('temporal values', () => {
		assert_parity(Temporal.Instant.from('2023-11-14T22:13:20Z'));
		assert_parity(Temporal.PlainDate.from('2023-11-14'));
	});
});

// ---------------------------------------------------------------------------
// The value is never touched directly
// ---------------------------------------------------------------------------

// Executable proof of the core claim of custom operations: with a complete
// implementation, the stringify algorithm never touches the value being
// serialized — every introspection goes through the operations. Values are
// wrapped in "tripwire" proxies whose every trap records a violation and
// throws; the operations unwrap through a WeakMap side-channel, so any direct
// touch (a stray `thing.foo` in stringify.js) trips instantly with the trap
// name and key.

/** @type {WeakMap<object, any>} */
const tripwire_targets = new WeakMap();

/** @type {string[]} */
let tripwire_violations = [];

/** engine-level `.then` reads from the promise resolution procedure */
let tripwire_then_probes = 0;

const TRIPWIRE_TRAPS = /** @type {const} */ ([
	'apply',
	'construct',
	'defineProperty',
	'deleteProperty',
	'get',
	'getOwnPropertyDescriptor',
	'getPrototypeOf',
	'has',
	'isExtensible',
	'ownKeys',
	'preventExtensions',
	'set',
	'setPrototypeOf'
]);

/**
 * Wraps an object in a proxy that records + throws on every trap.
 * Primitives are returned as-is (they cannot be touched).
 * @param {any} value
 */
function tripwire(value) {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
		return value;
	}

	/** @type {ProxyHandler<any>} */
	const handler = {};

	for (const trap of TRIPWIRE_TRAPS) {
		// @ts-expect-error dynamic trap definition
		handler[trap] = (_target, ...args) => {
			// When a promise fulfills with an object, the ECMAScript promise
			// resolution procedure reads `.then` on it — that is the engine,
			// not the serializer. `toPromise` could sidestep this by fulfilling
			// with an inert (non-proxy) handle, but an inert handle cannot
			// observe reads, and the handle is exactly the object a stray
			// direct touch in stringify.js would land on — so wrapping it in
			// the tripwire is what gives the suite its teeth on async paths.
			// The engine probe is the one read that then cannot be prevented:
			// absorb it (the underlying value is never touched) and count it,
			// so tests can assert exactly when it occurs.
			if (trap === 'get' && args[0] === 'then') {
				tripwire_then_probes += 1;
				return undefined;
			}

			const detail =
				typeof args[0] === 'string' || typeof args[0] === 'symbol'
					? ` (${String(args[0])})`
					: '';
			tripwire_violations.push(trap + detail);
			throw new Error(`value touched directly: ${trap}${detail}`);
		};
	}

	const proxy = new Proxy(value, handler);
	tripwire_targets.set(proxy, value);
	return proxy;
}

/** @param {any} value */
const untrip = (value) => (tripwire_targets.has(value) ? tripwire_targets.get(value) : value);

/**
 * A complete operations implementation that only ever consults the WeakMap —
 * never the proxy. Every recursively-serialized value is re-wrapped in a
 * fresh tripwire so nested objects are protected too.
 *
 * @type {import('../src/types.js').StringifyOperations}
 */
const tripwire_operations = {
	identify: (value) => untrip(value),
	typeOf: (value) => {
		const raw = untrip(value);
		return raw === null ? 'null' : typeof raw;
	},
	toPrimitive: (value) => untrip(value),
	tagOf: (value) => defaultOperations.tagOf(untrip(value)),
	isThenable: (value) => typeof untrip(value).then === 'function',
	toPromise: (value) => Promise.resolve(untrip(value)).then(tripwire),
	unbox: (value) => tripwire(untrip(value).valueOf()),
	toISOString: (value) => defaultOperations.toISOString(untrip(value)),
	toStringValue: (value) => untrip(value).toString(),
	regExpInfo: (value) => defaultOperations.regExpInfo(untrip(value)),
	valuesOf: (value) => [...untrip(value)].map(tripwire),
	entriesOf: (value) => [...untrip(value)].map(([k, v]) => [tripwire(k), tripwire(v)]),
	viewInfo: (value) => {
		const info = defaultOperations.viewInfo(untrip(value));
		return { ...info, buffer: tripwire(info.buffer) };
	},
	toArrayBuffer: (value) => untrip(value),
	lengthOf: (value) => untrip(value).length,
	hasOwn: (value, key) => Object.hasOwn(untrip(value), key),
	indicesOf: (value) => defaultOperations.indicesOf(untrip(value)),
	shapeOf: (value) => defaultOperations.shapeOf(untrip(value)),
	get: (value, key) => tripwire(untrip(value)[key])
};

suite('tripwire operations (value is never touched)', (test) => {
	/** @param {any} value */
	function assert_untouched(value) {
		tripwire_violations = [];
		tripwire_then_probes = 0;

		const result = stringify(tripwire(value), undefined, {
			operations: tripwire_operations
		});

		assert.equal(tripwire_violations, [], `traps fired: ${tripwire_violations.join(', ')}`);
		assert.equal(tripwire_then_probes, 0, 'sync serialization must never read .then');
		assert.equal(result, stringify(value), 'output parity');
	}

	test('sync serialization never touches the value', () => {
		const shared = { x: 1 };

		/** @type {any} */
		const cyclic = { name: 'cycle' };
		cyclic.self = cyclic;

		const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

		const sparse = [];
		sparse[100] = 'x';

		assert_untouched({ a: 1, nested: { b: [2, 3] }, first: shared, second: shared });
		// eslint-disable-next-line no-sparse-arrays
		assert_untouched([1, 'two', { three: 3 }, , 5]);
		assert_untouched(sparse);
		assert_untouched(new Date(1700000000000));
		assert_untouched(/ab+c/gi);
		assert_untouched(new Map([['k', { v: 1 }], [shared, shared]]));
		assert_untouched(new Set([1, { two: 2 }]));
		assert_untouched(new URL('https://example.com/?q=1'));
		assert_untouched(Object.assign(Object.create(null), { x: 1 }));
		assert_untouched(new Number(42));
		assert_untouched(new String('boxed'));
		assert_untouched(buffer);
		assert_untouched(new Uint8Array(buffer));
		assert_untouched(new Int16Array(buffer, 2, 2));
		assert_untouched(new DataView(buffer, 1, 4));
		assert_untouched(cyclic);
	});

	test('async serialization only incurs engine-level .then reads on the proxy', async () => {
		tripwire_violations = [];
		tripwire_then_probes = 0;

		const value = { p: Promise.resolve({ deep: Promise.resolve(42) }) };

		const result = await stringifyAsync(tripwire(value), undefined, {
			operations: tripwire_operations
		});

		assert.equal(tripwire_violations, [], `traps fired: ${tripwire_violations.join(', ')}`);
		// exactly one: the promise resolution procedure reading .then on the
		// (re-wrapped) object that `p` fulfills with — absorbed by the proxy,
		// never reaching the underlying value. `42` is a primitive, so the
		// inner promise adds none.
		assert.equal(tripwire_then_probes, 1);
		assert.equal(result, await stringifyAsync(value));
	});

	test('reducers receive the untouched proxy', () => {
		class Custom {
			/** @param {any} inner */
			constructor(inner) {
				this.inner = inner;
			}
		}

		tripwire_violations = [];
		tripwire_then_probes = 0;

		const result = stringify(
			tripwire(new Custom('yes')),
			{
				Custom: (value) =>
					untrip(value) instanceof Custom && tripwire({ inner: untrip(value).inner })
			},
			{ operations: tripwire_operations }
		);

		assert.equal(tripwire_violations, []);
		assert.equal(parse(result, { Custom: (value) => value }).inner, 'yes');
	});

	test('negative control: default operations trip the wire', () => {
		// proves the tripwire actually detects touches — without it, the other
		// tests would pass vacuously
		tripwire_violations = [];

		assert.throws(() => stringify(tripwire({ a: 1 })), /value touched directly/);
		assert.ok(tripwire_violations.length > 0);
	});
});

// ---------------------------------------------------------------------------
// filterArrayIndices helper
// ---------------------------------------------------------------------------

suite('filterArrayIndices', (test) => {
	test('keeps the leading run of valid array indices', () => {
		assert.equal(filterArrayIndices(['0', '1', '2']), ['0', '1', '2']);
		assert.equal(filterArrayIndices(['0', '2', '7']), ['0', '2', '7']);
		assert.equal(filterArrayIndices([]), []);
	});

	test('trims trailing non-index keys', () => {
		assert.equal(filterArrayIndices(['0', '1', 'extra']), ['0', '1']);
		assert.equal(filterArrayIndices(['0', 'a', 'b']), ['0']);
		assert.equal(filterArrayIndices(['a', 'b']), []);
	});

	test('rejects index-like strings that are not valid indices', () => {
		assert.equal(filterArrayIndices(['0', '01']), ['0']);
		assert.equal(filterArrayIndices(['0', '-1']), ['0']);
		assert.equal(filterArrayIndices(['0', '1.5']), ['0']);
		assert.equal(filterArrayIndices(['0', '4294967295']), ['0']);
	});

	test('does not modify the input', () => {
		const keys = ['0', '1', 'extra'];
		filterArrayIndices(keys);
		assert.equal(keys, ['0', '1', 'extra']);
	});

	test('matches the default operation for the same value', () => {
		const array = [1, 2, 3];
		array.extra = 'x';
		assert.equal(
			filterArrayIndices(Object.keys(array)),
			defaultOperations.indicesOf(array)
		);
	});
});
