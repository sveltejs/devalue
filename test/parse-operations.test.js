import assert from 'node:assert/strict';
import * as vm from 'vm';
import { describe, test, expect } from 'vitest';
import {
	stringify,
	parse,
	unflatten,
	defaultParseOperations,
	defaultStringifyOperations
} from '../index.js';

globalThis.Temporal ??= (await import('@js-temporal/polyfill')).Temporal;

// ---------------------------------------------------------------------------
// Basic plumbing
// ---------------------------------------------------------------------------

describe('parse operations option', () => {
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

		expect(result).toEqual({ a: 1, b: [2, 3] });
		// `set` serves objects and arrays alike (the inverse of `get`):
		// a, b, b[0], b[1]
		expect(calls).toEqual(4);
	});

	test('explicitly-undefined overrides fall back to defaults', () => {
		const result = parse(stringify({ a: 1, when: new Date(1700000000000) }), undefined, {
			operations: {
				fromISOString: undefined,
				set: undefined,
				createObject: () => ({})
			}
		});

		expect(result).toEqual({ a: 1, when: new Date(1700000000000) });
	});

	test('defaultParseOperations is exported, frozen and delegable', () => {
		expect(Object.isFrozen(defaultParseOperations)).toBeTruthy();

		const result = parse(stringify(new Map([['k', 'v']])), undefined, {
			operations: {
				createMap: () => defaultParseOperations.createMap()
			}
		});

		expect(result).toEqual(new Map([['k', 'v']]));
	});

	test('unflatten accepts operations too', () => {
		const result = unflatten([['Date', '2023-11-14T22:13:20.000Z']], undefined, {
			operations: {
				fromISOString: (iso) => `date:${iso}`
			}
		});

		expect(result).toEqual('date:2023-11-14T22:13:20.000Z');
	});

	test('invalid null-prototype keys are rejected before hydration or assignment', () => {
		const calls = [];
		const options = {
			operations: {
				fromPrimitive(value) {
					calls.push('fromPrimitive');
					return value;
				},
				set(target, key, value) {
					calls.push('set');
					target[key] = value;
				}
			}
		};
		const json = '[["null",["__proto__"],1],{"isAdmin":2},true]';
		const message = 'Cannot parse an object with a non-string key';

		assert.throws(
			() => parse(json, undefined, options),
			(error) => error.message === message
		);
		assert.throws(
			() => unflatten(JSON.parse(json), undefined, options),
			(error) => error.message === message
		);
		expect(calls).toStrictEqual([]);
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

		expect(revived instanceof Vector).toBeTruthy();
		expect(revived.x).toEqual(30);
		expect(revived.y).toEqual(40);
		// the reviver's payload array went through the custom operation
		expect(created).toEqual(1);
	});
});

// ---------------------------------------------------------------------------
// Sparse array DoS protection is preserved through the operation boundary
// ---------------------------------------------------------------------------

describe('sparse arrays', () => {
	test('createSparseArray produces the declared length without eager allocation', () => {
		// A tiny payload declaring a huge length must not allocate.
		const revived = unflatten([[-7, 50_000_000, 3, 1], 'x']);

		expect(revived.length).toEqual(50_000_000);
		expect(revived[3]).toEqual('x');
		expect(Object.keys(revived)).toEqual(['3']);
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

		expect(lengths).toEqual([1234]);
	});
});

// ---------------------------------------------------------------------------
// Revived view backing buffers
// ---------------------------------------------------------------------------

describe.each([parse, unflatten].map((fn) => ({ fn })))(
	'$fn.name view backing buffers',
	({ fn }) => {
		function revive(values, revivers, options) {
			return fn(fn === parse ? JSON.stringify(values) : values, revivers, options);
		}

		const constructors = [
			Int8Array,
			Uint8Array,
			Uint8ClampedArray,
			Int16Array,
			Uint16Array,
			globalThis.Float16Array,
			Int32Array,
			Uint32Array,
			Float32Array,
			Float64Array,
			BigInt64Array,
			BigUint64Array,
			DataView
		].filter(Boolean);

		describe.each(constructors.map((Constructor) => ({ Constructor })))(
			'$Constructor.name',
			({ Constructor }) => {
				describe.each([{ bounds: [] }, { bounds: [0, 1] }])('bounds=$bounds', ({ bounds }) => {
					// Keep these lengths small so regressions cannot exhaust memory.
					test.each([
						{ payload: [1024] },
						{ payload: [[-7, 1024]] },
						{ payload: [{ length: 3 }, 1024] }
					])('rejects revived lengths and array-like values ($payload)', ({ payload }) => {
						assert.throws(
							() =>
								revive([[Constructor.name, 1, ...bounds], ['ArrayBuffer', 2], ...payload], {
									ArrayBuffer: (value) => value
								}),
							(error) => error instanceof TypeError
						);
					});
				});

				describe.each([
					{ name: 'ArrayBuffer', create: () => new ArrayBuffer(16) },
					{ name: 'ArrayBuffer subclass', create: () => new (class extends ArrayBuffer {})(16) },
					{ name: 'SharedArrayBuffer', create: () => new SharedArrayBuffer(16) },
					{
						name: 'cross-realm ArrayBuffer',
						create: () => vm.runInNewContext('new ArrayBuffer(16)')
					},
					{
						name: 'cross-realm SharedArrayBuffer',
						create: () => vm.runInNewContext('new SharedArrayBuffer(16)')
					}
				])('$name', ({ create }) => {
					test.each([{ bounds: [] }, { bounds: [8, 1] }])(
						'accepts genuine revived backing buffers (bounds=$bounds)',
						({ bounds }) => {
							const buffer = create();
							const result = revive([[Constructor.name, 1, ...bounds], ['ArrayBuffer', 2], null], {
								ArrayBuffer: () => buffer
							});

							expect(result instanceof Constructor).toBeTruthy();
							expect(result.buffer).toBe(buffer);
							expect(result.byteOffset).toBe(bounds[0] ?? 0);
							expect(result.byteLength).toBe(
								bounds.length ? (Constructor.BYTES_PER_ELEMENT ?? 1) : 16
							);
						}
					);
				});
			}
		);

		test.each([
			{ name: 'spoofed tag', create: (fake) => fake },
			{ name: 'forged prototype', create: () => Object.create(ArrayBuffer.prototype) },
			{ name: 'proxy', create: () => new Proxy(new ArrayBuffer(16), {}) },
			{ name: 'typed array', create: () => new Uint8Array(16) },
			{ name: 'null', create: () => null },
			{ name: 'undefined', create: () => undefined },
			{ name: 'string', create: () => '1024' }
		])('rejects spoofed buffers without reading their properties ($name)', ({ create }) => {
			let reads = 0;
			const fake = {
				[Symbol.toStringTag]: 'ArrayBuffer',
				get byteLength() {
					reads += 1;
					return 16;
				},
				get length() {
					reads += 1;
					return 1024;
				}
			};

			const buffer = create(fake);
			assert.throws(
				() =>
					revive([['Uint8Array', 1], ['ArrayBuffer', 2], null], {
						ArrayBuffer: () => buffer
					}),
				(error) => error instanceof TypeError
			);

			expect(reads).toBe(0);
		});

		describe.each([ArrayBuffer, SharedArrayBuffer].map((Constructor) => ({ Constructor })))(
			'$Constructor.name with shadowed properties',
			({ Constructor }) => {
				test.each([0, 16])(
					'accepts empty buffers and ignores shadowed buffer properties (length=%i)',
					(length) => {
						const buffer = new Constructor(length);
						Object.defineProperties(buffer, {
							byteLength: {
								get() {
									throw new Error('must use the native byteLength getter');
								}
							},
							[Symbol.toStringTag]: { value: 'Object' }
						});

						const result = revive([['Uint8Array', 1], ['ArrayBuffer', 2], null], {
							ArrayBuffer: () => buffer
						});

						expect(result.buffer).toBe(buffer);
						expect(result.byteLength).toBe(length);
					}
				);
			}
		);

		test('validates backing buffers returned by custom operations', () => {
			assert.throws(
				() =>
					revive(
						[
							['Uint8Array', 1],
							['ArrayBuffer', 'AA==']
						],
						undefined,
						{
							operations: { fromArrayBuffer: () => 1024 }
						}
					),
				(error) => error instanceof TypeError
			);
		});

		test('validates previously revived backing buffers', () => {
			assert.throws(
				() =>
					revive([[1, 3], ['ArrayBuffer', 2], 1024, ['Uint8Array', 1]], {
						ArrayBuffer: (value) => value
					}),
				(error) => error instanceof TypeError
			);
		});

		test('allows custom view operations to use opaque revived buffers', () => {
			const handle = {};
			const result = revive(
				[['Uint8Array', 1, 2, 4], ['ArrayBuffer', 2], null],
				{ ArrayBuffer: () => handle },
				{
					operations: {
						fromViewInfo: (tag, buffer, byteOffset, length) => {
							expect(buffer).toBe(handle);
							return { tag, byteOffset, length };
						}
					}
				}
			);

			expect(result).toStrictEqual({ tag: 'Uint8Array', byteOffset: 2, length: 4 });
		});
	}
);

// ---------------------------------------------------------------------------
// Cross-realm revival (node:vm)
// ---------------------------------------------------------------------------

describe('cross-realm operations', () => {
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
		expect(revived.when.toISOString()).toEqual('2023-11-14T22:13:20.000Z');
		expect(revived.pattern.source).toEqual('ab+c');
		expect(revived.pattern.flags).toEqual('gi');
		expect([...revived.set]).toEqual([1, 2]);
		// entries are flattened to primitives: the inner arrays belong to the
		// other realm, so a structural comparison would fail on the prototype
		expect([...revived.map].map(([k, v]) => `${k}=${v}`)).toEqual(['k=v']);
		expect([...revived.list]).toEqual([1, 2, 3]);
		expect(revived.bare.x).toEqual(1);

		// ...built from the *other* realm's intrinsics, so host `instanceof`
		// fails while the sandbox's own checks succeed.
		expect(revived.when instanceof Date).toBeFalsy();
		expect(revived.list instanceof Array).toBeFalsy();

		context.probe = revived;
		expect(
			vm.runInContext(
				`probe.when instanceof Date &&
				 probe.pattern instanceof RegExp &&
				 probe.set instanceof Set &&
				 probe.map instanceof Map &&
				 Array.isArray(probe.list) &&
				 Object.getPrototypeOf(probe.bare) === null`,
				context
			)
		).toBeTruthy();
	});

	test('typed arrays are constructed in the target realm', () => {
		const context = vm.createContext({});
		const operations = realm_operations(context);

		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const revived = parse(stringify(bytes), undefined, { operations });

		expect([...revived]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(revived instanceof Uint8Array).toBeFalsy();

		context.probe = revived;
		expect(
			vm.runInContext('probe instanceof Uint8Array && probe.buffer instanceof ArrayBuffer', context)
		).toBeTruthy();
	});

	test('cyclic values are linked correctly across realms', () => {
		const context = vm.createContext({});
		const operations = realm_operations(context);

		/** @type {any} */
		const cyclic = { name: 'cycle' };
		cyclic.self = cyclic;
		cyclic.list = [cyclic];

		const revived = parse(stringify(cyclic), undefined, { operations });

		expect(revived.self).toBe(revived);
		expect(revived.list[0]).toBe(revived);

		context.probe = revived;
		expect(
			vm.runInContext('probe.self === probe && probe.list[0] === probe', context)
		).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Constructed values are never touched directly
// ---------------------------------------------------------------------------

describe('tripwire parse operations', () => {
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
		fromStringValue: (tag, text) => tripwire(defaultParseOperations.fromStringValue(tag, text)),
		fromArrayBuffer: (buffer) => tripwire(buffer),
		fromRegExpInfo: (source, flags) => tripwire(new RegExp(source, flags)),
		fromViewInfo: (tag, buffer, byteOffset, length) =>
			tripwire(defaultParseOperations.fromViewInfo(tag, untrip(buffer), byteOffset, length)),
		box: (value) => tripwire(Object(untrip(value))),
		createArray: (length) => tripwire(new Array(length)),
		createSparseArray: (length) => tripwire(defaultParseOperations.createSparseArray(length)),
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

		expect(root.object.shared).toBe(root.array[0]);
		expect(root.array[2].self).toBe(root.array[2]);
		expect(root.sparse.length).toEqual(1000);
		expect(root.sparse[999]).toBe(root.array[0]);
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

describe('handle-based parse operations', () => {
	/** @param {any} value */
	function assert_round_trip(value) {
		const revived = parse(stringify(value), undefined, {
			operations: handle_operations
		});

		expect(revived instanceof Handle, 'root should be a handle').toBeTruthy();
		expect(raw(revived)).toEqual(parse(stringify(value)));
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
		expect(object.first).toBe(object.second);
	});

	test('cyclic values', () => {
		/** @type {any} */
		const cyclic = { name: 'cycle' };
		cyclic.self = cyclic;

		const revived = parse(stringify(cyclic), undefined, {
			operations: handle_operations
		});

		const object = raw(revived);
		expect(object.self).toBe(object);
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
					expect(handle instanceof Handle).toBeTruthy();
					return h(new Custom(raw(handle)));
				}
			},
			{ operations: handle_operations }
		);

		expect(revived instanceof Handle).toBeTruthy();
		expect(raw(revived) instanceof Custom).toBeTruthy();
		expect(raw(revived).inner).toEqual('yes');
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

		expect(serialized).toEqual(stringify(original));

		const revived = parse(serialized, undefined, { operations: handle_operations });

		expect(raw(revived).list).toEqual([1, 2]);
		expect(raw(revived).when.getTime()).toEqual(1700000000000);
	});
});
