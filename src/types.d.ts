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
 */
export interface StringifyOperations {
	/**
	 * Returns the key used for deduplication and cycle detection (compared
	 * with `Map` key semantics). Two values that represent the same logical
	 * object must return the same key. Default: the value itself.
	 *
	 * Override this when serializing through handles, where two distinct
	 * handle objects may refer to the same underlying value.
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
	primitive(value: any): undefined | null | boolean | number | bigint | string;

	/**
	 * Returns the brand of an object value — the strings produced by
	 * `Object.prototype.toString` without the wrapping (`'Date'`, `'Array'`,
	 * `'Map'`, `'Object'`, `'Temporal.Instant'`, …). This decides which
	 * serialization strategy is used, so hardened implementations should use
	 * engine-level brand checks rather than (spoofable, getter-invoking)
	 * `Symbol.toStringTag` lookups.
	 */
	tag(value: any): string;

	/** Returns true if the object value should be treated as a thenable. */
	isThenable(value: any): boolean;

	/**
	 * Resolves a thenable to its settled value (which is then serialized).
	 * Only called from `stringifyAsync` for values where `isThenable`
	 * returned true.
	 */
	resolveThenable(value: any): Promise<any>;

	/**
	 * Extracts the inner value of a boxed primitive (`Number`, `String`,
	 * `Boolean`, `BigInt` objects). Equivalent to `value.valueOf()`. The
	 * result is serialized recursively, so it may be a foreign value/handle.
	 */
	unbox(value: any): any;

	/**
	 * Returns the ISO string for a `Date` value, or `''` for an invalid
	 * date. Equivalent to `value.toISOString()`.
	 */
	dateISO(value: any): string;

	/**
	 * Returns the string form of a `URL`, `URLSearchParams` or `Temporal.*`
	 * value. Equivalent to `value.toString()`.
	 */
	toStringValue(value: any): string;

	/** Returns the source and flags of a `RegExp` value. */
	regExp(value: any): { source: string; flags: string };

	/**
	 * Returns an iterable over the elements of a `Set` value. The iterable
	 * is consumed on the host; elements may be foreign values/handles.
	 */
	setValues(value: any): Iterable<any>;

	/**
	 * Returns an iterable over the `[key, value]` entries of a `Map` value.
	 * The iterable is consumed on the host; keys/values may be foreign
	 * values/handles.
	 */
	mapEntries(value: any): Iterable<[any, any]>;

	/**
	 * Returns the view metadata of a typed array or `DataView` value.
	 * `length` is only meaningful for typed arrays. `buffer` is serialized
	 * recursively, so it may be a foreign value/handle.
	 */
	viewInfo(value: any): {
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
	arrayBuffer(value: any): ArrayBuffer;

	/** Returns the length of an `Array` value. */
	arrayLength(value: any): number;

	/** Returns true if an `Array` value has an own element at `index`. */
	hasOwnIndex(value: any, index: number): boolean;

	/**
	 * Returns the populated indices of a (sparse) `Array` value as strings,
	 * in ascending order. Equivalent to `Object.keys(value)` filtered to
	 * valid array indices.
	 */
	arrayIndices(value: any): string[];

	/**
	 * Classifies a plain-object candidate:
	 * - `{ kind: 'plain' | 'null-proto', keys }` — a serializable POJO and
	 *   its own enumerable string keys
	 * - `{ kind: 'not-plain' }` — a non-POJO (stringify throws)
	 * - `{ kind: 'symbol-keys' }` — a POJO with enumerable symbol keys
	 *   (stringify throws)
	 */
	objectShape(
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
