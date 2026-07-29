import * as vm from 'vm';
import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import {
	stringify,
	parse,
	unflatten,
	defaultParseOperations,
	defaultStringifyOperations
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
// Basic plumbing
// ---------------------------------------------------------------------------

suite('parse operations option', (test) => {
	test('partial overrides merge over defaults', () => {
		let calls = 0;

		const result = parse(stringify({ a: 1, b: [2, 3] }), undefined, {
			operations: {
				set(object, key, value) {
					calls += 1;
					object[key] = value;
				}
			}
		});

		assert.equal(result, { a: 1, b: [2, 3] });
		// `set` serves objects and arrays alike (the inverse of `get`):
		// a, b, b[0], b[1]
		assert.equal(calls, 4);
	});

	test('explicitly-undefined overrides fall back to defaults', () => {
		const result = parse(stringify({ a: 1, when: new Date(1700000000000) }), undefined, {
			operations: {
				fromISOString: undefined,
				set: undefined,
				createObject: () => ({})
			}
		});

		assert.equal(result, { a: 1, when: new Date(1700000000000) });
	});

	test('defaultParseOperations is exported, frozen and delegable', () => {
		assert.ok(Object.isFrozen(defaultParseOperations));

		const result = parse(stringify(new Map([['k', 'v']])), undefined, {
			operations: {
				createMap: () => defaultParseOperations.createMap()
			}
		});

		assert.equal(result, new Map([['k', 'v']]));
	});

	test('unflatten accepts operations too', () => {
		const result = unflatten([['Date', '2023-11-14T22:13:20.000Z']], undefined, {
			operations: {
				fromISOString: (iso) => `date:${iso}`
			}
		});

		assert.equal(result, 'date:2023-11-14T22:13:20.000Z');
	});

	test('revivers compose with custom operations', () => {
		class Vector {
			constructor(x, y) {
				this.x = x;
				this.y = y;
			}
		}

		let created = 0;

		const serialized = stringify(new Vector(30, 40), {
			Vector: (value) => value instanceof Vector && [value.x, value.y]
		});

		const revived = parse(
			serialized,
			{ Vector: ([x, y]) => new Vector(x, y) },
			{
				operations: {
					createArray(length) {
						created += 1;
						return new Array(length);
					}
				}
			}
		);

		assert.ok(revived instanceof Vector);
		assert.equal(revived.x, 30);
		assert.equal(revived.y, 40);
		// the reviver's payload array went through the custom operation
		assert.equal(created, 1);
	});
});

// ---------------------------------------------------------------------------
// Sparse array DoS protection is preserved through the operation boundary
// ---------------------------------------------------------------------------

suite('sparse arrays', (test) => {
	test('createSparseArray produces the declared length without eager allocation', () => {
		// A tiny payload declaring a huge length must not allocate.
		const revived = unflatten([[-7, 50_000_000, 3, 1], 'x']);

		assert.equal(revived.length, 50_000_000);
		assert.equal(revived[3], 'x');
		assert.equal(Object.keys(revived), ['3']);
	});

	test('createSparseArray override receives the declared length', () => {
		/** @type {number[]} */
		const lengths = [];

		unflatten([[-7, 1234, 3, 1], 'x'], undefined, {
			operations: {
				createSparseArray(length) {
					lengths.push(length);
					return defaultParseOperations.createSparseArray(length);
				}
			}
		});

		assert.equal(lengths, [1234]);
	});
});

// ---------------------------------------------------------------------------
// Cross-realm revival (node:vm)
// ---------------------------------------------------------------------------

suite('cross-realm operations', (test) => {
	// Note: `URL`/`URLSearchParams` are Node globals rather than ECMAScript
	// intrinsics, so a bare vm context has none to construct from — only the
	// ES intrinsics are exercised here.
	/** @returns {Partial<import('../src/types.js').ParseOperations>} */
	function realm_operations(context) {
		const intrinsics = vm.runInContext(
			`({
				Date, RegExp, Set, Map, Object, Array,
				createObject: () => ({}),
				createNullPrototypeObject: () => Object.create(null)
			})`,
			context
		);

		return {
			fromISOString: (iso) => new intrinsics.Date(iso),
			fromRegExpInfo: (source, flags) => new intrinsics.RegExp(source, flags),
			createSet: () => new intrinsics.Set(),
			createMap: () => new intrinsics.Map(),
			createObject: () => intrinsics.createObject(),
			createNullPrototypeObject: () => intrinsics.createNullPrototypeObject(),
			createArray: (length) => new intrinsics.Array(length),
			fromViewInfo: (tag, buffer, byteOffset, length) => {
				const Constructor = vm.runInContext(tag, context);
				return byteOffset !== undefined
					? new Constructor(buffer, byteOffset, length)
					: new Constructor(buffer);
			},
			fromArrayBuffer: (buffer) => {
				const target = new (vm.runInContext('ArrayBuffer', context))(buffer.byteLength);
				new (vm.runInContext('Uint8Array', context))(target).set(new Uint8Array(buffer));
				return target;
			}
		};
	}

	test('values are constructed with the target realm intrinsics', () => {
		const context = vm.createContext({});
		const operations = realm_operations(context);

		const value = {
			when: new Date(1700000000000),
			pattern: /ab+c/gi,
			set: new Set([1, 2]),
			map: new Map([['k', 'v']]),
			list: [1, 2, 3],
			bare: Object.assign(Object.create(null), { x: 1 })
		};

		const revived = parse(stringify(value), undefined, { operations });

		// Correct values...
		assert.equal(revived.when.toISOString(), '2023-11-14T22:13:20.000Z');
		assert.equal(revived.pattern.source, 'ab+c');
		assert.equal(revived.pattern.flags, 'gi');
		assert.equal([...revived.set], [1, 2]);
		// entries are flattened to primitives: the inner arrays belong to the
		// other realm, so a structural comparison would fail on the prototype
		assert.equal(
			[...revived.map].map(([k, v]) => `${k}=${v}`),
			['k=v']
		);
		assert.equal([...revived.list], [1, 2, 3]);
		assert.equal(revived.bare.x, 1);

		// ...built from the *other* realm's intrinsics, so host `instanceof`
		// fails while the sandbox's own checks succeed.
		assert.not.ok(revived.when instanceof Date);
		assert.not.ok(revived.list instanceof Array);

		context.probe = revived;
		assert.ok(
			vm.runInContext(
				`probe.when instanceof Date &&
				 probe.pattern instanceof RegExp &&
				 probe.set instanceof Set &&
				 probe.map instanceof Map &&
				 Array.isArray(probe.list) &&
				 Object.getPrototypeOf(probe.bare) === null`,
				context
			)
		);
	});

	test('typed arrays are constructed in the target realm', () => {
		const context = vm.createContext({});
		const operations = realm_operations(context);

		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const revived = parse(stringify(bytes), undefined, { operations });

		assert.equal([...revived], [1, 2, 3, 4, 5, 6, 7, 8]);
		assert.not.ok(revived instanceof Uint8Array);

		context.probe = revived;
		assert.ok(
			vm.runInContext(
				'probe instanceof Uint8Array && probe.buffer instanceof ArrayBuffer',
				context
			)
		);
	});

	test('cyclic values are linked correctly across realms', () => {
		const context = vm.createContext({});
		const operations = realm_operations(context);

		/** @type {any} */
		const cyclic = { name: 'cycle' };
		cyclic.self = cyclic;
		cyclic.list = [cyclic];

		const revived = parse(stringify(cyclic), undefined, { operations });

		assert.equal(revived.self, revived);
		assert.equal(revived.list[0], revived);

		context.probe = revived;
		assert.ok(
			vm.runInContext('probe.self === probe && probe.list[0] === probe', context)
		);
	});
});

// ---------------------------------------------------------------------------
// Constructed values are never touched directly
// ---------------------------------------------------------------------------

suite('tripwire parse operations', (test) => {
	const values = new WeakMap();

	const handler = new Proxy(
		{},
		{
			get: (_, trap) => () => {
				throw new Error(`constructed value touched via ${String(trap)}`);
			}
		}
	);

	/** @param {any} value */
	function tripwire(value) {
		const handle = new Proxy({}, handler);
		values.set(handle, value);
		return handle;
	}

	/** @param {any} handle */
	function untrip(handle) {
		if (!values.has(handle)) throw new Error('expected a tripwire handle');
		return values.get(handle);
	}

	/** @type {import('../src/types.js').ParseOperations} */
	const operations = {
		fromPrimitive: (primitive) => tripwire(primitive),
		fromISOString: (iso) => tripwire(new Date(iso)),
		fromStringValue: (tag, text) =>
			tripwire(defaultParseOperations.fromStringValue(tag, text)),
		fromArrayBuffer: (buffer) => tripwire(buffer),
		fromRegExpInfo: (source, flags) => tripwire(new RegExp(source, flags)),
		fromViewInfo: (tag, buffer, byteOffset, length) =>
			tripwire(
				defaultParseOperations.fromViewInfo(
					tag,
					untrip(buffer),
					byteOffset,
					length
				)
			),
		box: (value) => tripwire(Object(untrip(value))),
		createArray: (length) => tripwire(new Array(length)),
		createSparseArray: (length) =>
			tripwire(defaultParseOperations.createSparseArray(length)),
		createObject: () => tripwire({}),
		createNullPrototypeObject: () => tripwire(Object.create(null)),
		createSet: () => tripwire(new Set()),
		createMap: () => tripwire(new Map()),
		set: (target, key, value) => {
			untrip(target)[key] = untrip(value);
		},
		addValue: (set, value) => {
			untrip(set).add(untrip(value));
		},
		addEntry: (map, key, value) => {
			untrip(map).set(untrip(key), untrip(value));
		}
	};

	test('parse only passes constructed values to operations', () => {
		const shared = { shared: true };
		const cyclic = { shared };
		cyclic.self = cyclic;

		const input = {
			primitive: 123n,
			date: new Date(1700000000000),
			url: new URL('https://example.com/path?q=1'),
			temporal: Temporal.Instant.from('2023-11-14T22:13:20Z'),
			regexp: /ab+c/gi,
			buffer: new Uint8Array([1, 2, 3, 4]).buffer,
			view: new Uint8Array([5, 6, 7, 8]),
			boxed: new Number(42),
			array: [shared, , cyclic],
			sparse: Object.assign(new Array(1000), { 999: shared }),
			object: { shared },
			null_object: Object.assign(Object.create(null), { shared }),
			set: new Set([shared]),
			map: new Map([[shared, cyclic]])
		};

		const revived = parse(stringify(input), undefined, { operations });
		const root = untrip(revived);

		assert.equal(root.object.shared, root.array[0]);
		assert.equal(root.array[2].self, root.array[2]);
		assert.equal(root.sparse.length, 1000);
		assert.equal(root.sparse[999], root.array[0]);
	});
});

// ---------------------------------------------------------------------------
// Foreign-runtime (handle-based) revival
// ---------------------------------------------------------------------------

// A stand-in for a VM value handle (e.g. a QuickJS-in-WASM JSValueHandle).
// `parse` never inspects the values it builds — it only feeds them back into
// other operations — so a fully opaque wrapper is enough.
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

/** @type {import('../src/types.js').ParseOperations} */
const handle_operations = {
	fromPrimitive: (primitive) => h(primitive),
	fromISOString: (iso) => h(new Date(iso)),
	fromRegExpInfo: (source, flags) => h(new RegExp(source, flags)),
	fromStringValue: (tag, text) => h(defaultParseOperations.fromStringValue(tag, text)),
	box: (value) => h(Object(raw(value))),
	fromArrayBuffer: (buffer) => h(buffer),
	fromViewInfo: (tag, buffer, byteOffset, length) =>
		h(defaultParseOperations.fromViewInfo(tag, raw(buffer), byteOffset, length)),
	createArray: (length) => h(new Array(length)),
	createSparseArray: (length) => h(defaultParseOperations.createSparseArray(length)),

	createObject: () => h({}),
	createNullPrototypeObject: () => h(Object.create(null)),
	set: (target, key, value) => {
		raw(target)[key] = raw(value);
	},
	createSet: () => h(new Set()),
	addValue: (set, value) => {
		raw(set).add(raw(value));
	},
	createMap: () => h(new Map()),
	addEntry: (map, key, value) => {
		raw(map).set(raw(key), raw(value));
	}
};

suite('handle-based parse operations', (test) => {
	/** @param {any} value */
	function assert_round_trip(value) {
		const revived = parse(stringify(value), undefined, {
			operations: handle_operations
		});

		assert.ok(revived instanceof Handle, 'root should be a handle');
		assert.equal(raw(revived), parse(stringify(value)));
	}

	test('primitives', () => {
		assert_round_trip(42);
		assert_round_trip(-0);
		assert_round_trip(NaN);
		assert_round_trip(Infinity);
		assert_round_trip(-Infinity);
		assert_round_trip('hello');
		assert_round_trip(true);
		assert_round_trip(null);
		assert_round_trip(undefined);
		assert_round_trip(123n);
	});

	test('objects, arrays and special types', () => {
		assert_round_trip({ a: 1, nested: { b: [2, 3] } });
		assert_round_trip([1, 'two', { three: 3 }]);
		assert_round_trip(new Date(1700000000000));
		assert_round_trip(/ab+c/gi);
		assert_round_trip(new Map([['k', { v: 1 }]]));
		assert_round_trip(new Set([1, 2, 3]));
		assert_round_trip(new URL('https://example.com/path?q=1'));
		assert_round_trip(new URLSearchParams('a=1&b=2'));
		// eslint-disable-next-line no-sparse-arrays
		assert_round_trip([1, , 3]);
		assert_round_trip(Object.assign(Object.create(null), { x: 1 }));
		assert_round_trip(new Number(42));
		assert_round_trip(Temporal.Instant.from('2023-11-14T22:13:20Z'));
	});

	test('typed arrays and buffers', () => {
		const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
		assert_round_trip(buffer);
		assert_round_trip(new Uint8Array(buffer));
		assert_round_trip(new Int16Array(buffer, 2, 2)); // subarray
		assert_round_trip(new DataView(buffer, 1, 4));
	});

	test('repeated references share one handle-built value', () => {
		const shared = { x: 1 };
		const revived = parse(stringify({ first: shared, second: shared }), undefined, {
			operations: handle_operations
		});

		const object = raw(revived);
		assert.equal(object.first, object.second);
	});

	test('cyclic values', () => {
		/** @type {any} */
		const cyclic = { name: 'cycle' };
		cyclic.self = cyclic;

		const revived = parse(stringify(cyclic), undefined, {
			operations: handle_operations
		});

		const object = raw(revived);
		assert.equal(object.self, object);
	});

	test('revivers receive and return handles', () => {
		class Custom {
			constructor(inner) {
				this.inner = inner;
			}
		}

		const revived = parse(
			'[["Custom",1],"yes"]',
			{
				Custom: (handle) => {
					assert.ok(handle instanceof Handle);
					return h(new Custom(raw(handle)));
				}
			},
			{ operations: handle_operations }
		);

		assert.ok(revived instanceof Handle);
		assert.ok(raw(revived) instanceof Custom);
		assert.equal(raw(revived).inner, 'yes');
	});

	test('round-trips through both operation sets', () => {
		// stringify a handle-wrapped value with the stringify operations from
		// the companion feature, then revive it back into handles
		const original = { list: [1, 2], when: new Date(1700000000000) };

		/** @type {Partial<import('../src/types.js').StringifyOperations>} */
		const stringify_ops = {
			identify: (handle) => raw(handle),
			typeOf: (handle) => {
				const value = raw(handle);
				return value === null ? 'null' : typeof value;
			},
			toPrimitive: (handle) => raw(handle),
			tagOf: (handle) => defaultStringifyOperations.tagOf(raw(handle)),
			isThenable: () => false,
			toISOString: (handle) => defaultStringifyOperations.toISOString(raw(handle)),
			lengthOf: (handle) => raw(handle).length,
			hasOwn: (handle, key) => Object.hasOwn(raw(handle), key),
			indicesOf: (handle) => defaultStringifyOperations.indicesOf(raw(handle)),
			shapeOf: (handle) => defaultStringifyOperations.shapeOf(raw(handle)),
			get: (handle, key) => h(raw(handle)[key])
		};

		const serialized = stringify(h(original), undefined, {
			operations: stringify_ops
		});

		assert.equal(serialized, stringify(original));

		const revived = parse(serialized, undefined, { operations: handle_operations });

		assert.equal(raw(revived).list, [1, 2]);
		assert.equal(raw(revived).when.getTime(), 1700000000000);
	});
});
