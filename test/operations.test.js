import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import { stringify, stringifyAsync, defaultOperations, parse } from '../index.js';

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
					dateISO: undefined,
					tag: (value) => defaultOperations.tag(value)
				}
			}
		);

		assert.equal(result, stringify({ a: 1, date: new Date(1700000000000) }));
	});

	test('defaultOperations and objectShape sentinels are frozen', () => {
		assert.ok(Object.isFrozen(defaultOperations));
		assert.ok(Object.isFrozen(defaultOperations.objectShape(new Map())));
		assert.ok(
			Object.isFrozen(defaultOperations.objectShape({ [Symbol('key')]: 1 }))
		);
	});

	test('defaultOperations is exported and delegable', () => {
		const result = stringify(new Map([['k', 'v']]), undefined, {
			operations: {
				mapEntries: (value) => defaultOperations.mapEntries(value)
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

		/** @type {import('../src/types.js').StringifyOperations['objectShape']} */
		const objectShape = (value) =>
			value instanceof Wrapper
				? defaultOperations.objectShape(value.inner)
				: defaultOperations.objectShape(value);

		const result = stringify([a, b], undefined, {
			operations: {
				identify: (value) => (value instanceof Wrapper ? value.inner : value),
				tag: (value) => (value instanceof Wrapper ? 'Object' : defaultOperations.tag(value)),
				objectShape,
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
	test('dateISO override avoids patched Date.prototype.toISOString', () => {
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
					dateISO: (value) => original.call(value)
				}
			});

			assert.equal(patched_calls, 1); // unchanged
			assert.equal(result, `[["Date","2023-11-14T22:13:20.000Z"]]`);
		} finally {
			// eslint-disable-next-line no-extend-native
			Date.prototype.toISOString = original;
		}
	});

	test('mapEntries/setValues overrides avoid patched Symbol.iterator', () => {
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
					mapEntries: (map) => map_entries.call(map),
					setValues: (set) => set_values.call(set)
				}
			});

			assert.equal(patched_calls, 0);
			assert.equal(result, stringify({ map: new Map([[1, 2]]), set: new Set([3]) }));
		} finally {
			Map.prototype[Symbol.iterator] = map_iterator;
			Set.prototype[Symbol.iterator] = set_iterator;
		}
	});

	test('tag override is not fooled by Symbol.toStringTag getters', () => {
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
				tag: (value) => {
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
				objectShape: (value) => ({
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
	primitive: (handle) => raw(handle),
	tag: (handle) => defaultOperations.tag(raw(handle)),
	isThenable: (handle) => typeof raw(handle).then === 'function',
	resolveThenable: (handle) => Promise.resolve(raw(handle)).then(h),
	unbox: (handle) => h(raw(handle).valueOf()),
	dateISO: (handle) => defaultOperations.dateISO(raw(handle)),
	toStringValue: (handle) => raw(handle).toString(),
	regExp: (handle) => defaultOperations.regExp(raw(handle)),
	setValues: (handle) => [...raw(handle)].map(h),
	mapEntries: (handle) => [...raw(handle)].map(([k, v]) => [h(k), h(v)]),
	viewInfo: (handle) => {
		const info = defaultOperations.viewInfo(raw(handle));
		return { ...info, buffer: h(info.buffer) };
	},
	arrayBuffer: (handle) => raw(handle),
	arrayLength: (handle) => raw(handle).length,
	hasOwnIndex: (handle, index) => Object.hasOwn(raw(handle), index),
	arrayIndices: (handle) => defaultOperations.arrayIndices(raw(handle)),
	objectShape: (handle) => defaultOperations.objectShape(raw(handle)),
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

	test('async: thenables resolve through resolveThenable', async () => {
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
