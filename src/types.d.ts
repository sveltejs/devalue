export type TypedArray =
	| Int8Array
	| Uint8Array
	| Uint8ClampedArray
	| Int16Array
	| Uint16Array
	| Float16Array
	| Int32Array
	| Uint32Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array;

/**
 * The introspection/extraction operations `stringify` performs on the value
 * being serialized. Every dynamic operation — property reads, prototype
 * method calls, iteration, type classification — goes through this
 * interface, so overriding members lets you control exactly how values are
 * inspected.
 *
 * Use cases:
 * - **Side-effect-free serialization**: replace operations that can execute
 *   user code (getters, proxy traps, patched prototypes, `Symbol.toStringTag`
 *   accessors) with implementations based on captured intrinsics, internal
 *   slots, or property descriptors.
 * - **Foreign-runtime serialization**: serialize values that live in another
 *   JavaScript runtime (a `node:vm` context, a WASM-hosted engine, a remote
 *   process) by implementing the operations over handle objects. The
 *   `stringify` algorithm never touches the value directly, so "value" can
 *   be any opaque token as long as the operations agree on what it means.
 *
 * All members are optional when passed to `stringify` — omitted members fall
 * back to the defaults (native behavior, exported as `defaultOperations`).
 *
 * Members are named by what they do with the value:
 * - `isXxx`/`hasXxx` — predicates returning booleans
 * - `toXxx` — conversions whose whole result crosses into host JavaScript
 *   (`toPrimitive`, `toISOString`) or into a native container (`toPromise`)
 * - `xxxOf` — queries returning host data *about* the value (`typeOf`,
 *   `tagOf`, `lengthOf`) or its constituents, which remain in value space
 *   (`valuesOf`, `entriesOf`)
 * - `xxxInfo` — multi-field descriptors mixing host data and constituent
 *   values (`viewInfo`, `regExpInfo`)
 * - bare verbs (`get`, `unbox`, `identify`) — accessors whose results remain
 *   in value space
 *
 * (`toStringValue` and `unbox` deliberately avoid the names `toString` and
 * `valueOf`, which would shadow `Object.prototype` methods on the operations
 * object.)
 */
export interface StringifyOperations {
	/**
	 * Returns the key used for deduplication and cycle detection (compared
	 * with `Map` key semantics). Two values that represent the same logical
	 * object must return the same key. Default: the value itself.
	 *
	 * Override this when serializing through handles, where two distinct
	 * handle objects may refer to the same underlying value.
	 *
	 * Keys are compared across *every* value in the payload, including
	 * primitives, so an implementation that derives keys for objects must
	 * make sure they cannot collide with a primitive that appears in the
	 * same payload — returning e.g. the string `'42'` as an object's key
	 * would alias it to the string `'42'` elsewhere in the payload and emit
	 * a wrong back-reference. Prefer keys that are unforgeable, such as the
	 * underlying object itself, a symbol, or a wrapper object.
	 */
	identify(value: any): unknown;

	/**
	 * Classifies a value. Same contract as the `typeof` operator, except
	 * `null` must be reported as `'null'` (not `'object'`).
	 */
	typeOf(value: any):
		| 'undefined'
		| 'null'
		| 'boolean'
		| 'number'
		| 'bigint'
		| 'string'
		| 'symbol'
		| 'function'
		| 'object';

	/**
	 * Extracts the host-JavaScript primitive from a value whose `typeOf` is
	 * `'null'`, `'boolean'`, `'number'`, `'bigint'` or `'string'`.
	 * Default: the value itself (it already is the primitive).
	 */
	toPrimitive(value: any): undefined | null | boolean | number | bigint | string;

	/**
	 * Returns the brand of an object value — the strings produced by
	 * `Object.prototype.toString` without the wrapping (`'Date'`, `'Array'`,
	 * `'Map'`, `'Object'`, `'Temporal.Instant'`, …). This decides which
	 * serialization strategy is used, so hardened implementations should use
	 * engine-level brand checks rather than (spoofable, getter-invoking)
	 * `Symbol.toStringTag` lookups.
	 */
	tagOf(value: any): string;

	/** Returns true if the object value should be treated as a thenable. */
	isThenable(value: any): boolean;

	/**
	 * Converts a thenable into a native promise, whose settled value is then
	 * serialized. The returned promise may reject, in which case
	 * `stringifyAsync` rejects. Only called from `stringifyAsync`, for values
	 * where `isThenable` returned true.
	 */
	toPromise(thenable: any): Promise<any>;

	/**
	 * Extracts the inner value of a boxed primitive (`Number`, `String`,
	 * `Boolean`, `BigInt` objects). Equivalent to `boxed.valueOf()`. The
	 * result is serialized recursively, so it may be a foreign value/handle.
	 */
	unbox(boxed: any): any;

	/**
	 * Returns the ISO string for a `Date` value, or `''` for an invalid
	 * date. Equivalent to `date.toISOString()`.
	 */
	toISOString(date: any): string;

	/**
	 * Returns the string form of a `URL`, `URLSearchParams` or `Temporal.*`
	 * value. Equivalent to `value.toString()`.
	 */
	toStringValue(value: any): string;

	/** Returns the source and flags of a `RegExp` value. */
	regExpInfo(regexp: any): { source: string; flags: string };

	/**
	 * Returns an iterable over the elements of a `Set` value. The iterable
	 * is consumed on the host; elements may be foreign values/handles.
	 */
	valuesOf(set: any): Iterable<any>;

	/**
	 * Returns an iterable over the `[key, value]` entries of a `Map` value.
	 * The iterable is consumed on the host; keys/values may be foreign
	 * values/handles.
	 */
	entriesOf(map: any): Iterable<[any, any]>;

	/**
	 * Returns the view metadata of a typed array or `DataView` value.
	 * `length` is only meaningful for typed arrays. `buffer` is serialized
	 * recursively, so it may be a foreign value/handle.
	 */
	viewInfo(view: any): {
		buffer: any;
		byteOffset: number;
		byteLength: number;
		length?: number;
		bufferByteLength: number;
	};

	/**
	 * Returns a host `ArrayBuffer` with the bytes of an `ArrayBuffer` value.
	 * Default: the value itself. Foreign-runtime implementations should copy
	 * the bytes into a host buffer.
	 */
	toArrayBuffer(buffer: any): ArrayBuffer;

	/** Returns the length of an `Array` value. */
	lengthOf(array: any): number;

	/**
	 * Returns true if a value has an own property at `key`. Same contract as
	 * `Object.hasOwn(value, key)`.
	 */
	hasOwn(value: any, key: string | number): boolean;

	/**
	 * Returns the populated indices of a (sparse) `Array` value as strings,
	 * in ascending order. Equivalent to `Object.keys(array)` filtered to
	 * valid array indices.
	 */
	indicesOf(array: any): string[];

	/**
	 * Classifies a plain-object candidate:
	 * - `{ kind: 'plain' | 'null-proto', keys }` — a serializable POJO and
	 *   its own enumerable string keys
	 * - `{ kind: 'not-plain' }` — a non-POJO (stringify throws)
	 * - `{ kind: 'symbol-keys' }` — a POJO with enumerable symbol keys
	 *   (stringify throws)
	 */
	shapeOf(
		value: any
	):
		| { kind: 'plain' | 'null-proto'; keys: string[] }
		| { kind: 'not-plain' }
		| { kind: 'symbol-keys' };

	/**
	 * Reads a property from an `Array` or plain-object value. Equivalent to
	 * `value[key]`. Hardened implementations can read through property
	 * descriptors to control what happens for accessor properties.
	 */
	get(value: any, key: string | number): any;
}

/** Options for `stringify` and `stringifyAsync`. */
export interface StringifyOptions {
	/**
	 * Overrides for the introspection/extraction operations used while
	 * serializing. Omitted members fall back to `defaultOperations`.
	 */
	operations?: Partial<StringifyOperations>;
}
