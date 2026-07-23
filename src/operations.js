import {
	enumerable_symbols,
	get_type,
	is_plain_object,
	valid_array_indices
} from './utils.js';

/** @type {{ kind: 'not-plain' }} */
const NOT_PLAIN = Object.freeze({ kind: 'not-plain' });

/** @type {{ kind: 'symbol-keys' }} */
const SYMBOL_KEYS = Object.freeze({ kind: 'symbol-keys' });

/**
 * The default implementations of every introspection/extraction operation
 * `stringify` performs on the value being serialized. Each one matches the
 * behavior devalue has always had (native property access, iteration, etc).
 *
 * Pass overrides via the `operations` option of `stringify`/`stringifyAsync`
 * to customize how values are inspected — e.g. to serialize values without
 * triggering getters, proxy traps, or patched prototype methods, or to
 * serialize values that live in a different JavaScript runtime (a `node:vm`
 * context, a WASM-hosted engine, a remote process) through handle objects.
 *
 * The object is frozen — it is shared by every `stringify` call that does
 * not override a given operation.
 *
 * @type {import('./types.js').StringifyOperations}
 */
export const default_operations = Object.freeze({
	identify: (value) => value,

	typeOf: (value) => (value === null ? 'null' : typeof value),

	primitive: (value) => value,

	tag: (value) => get_type(value),

	isThenable: (value) => typeof value.then === 'function',

	resolveThenable: (value) => Promise.resolve(value),

	unbox: (value) => value.valueOf(),

	dateISO: (value) => (isNaN(value.getDate()) ? '' : value.toISOString()),

	toStringValue: (value) => value.toString(),

	regExp: (value) => ({ source: value.source, flags: value.flags }),

	setValues: (value) => value,

	mapEntries: (value) => value,

	viewInfo: (value) => ({
		buffer: value.buffer,
		byteOffset: value.byteOffset,
		byteLength: value.byteLength,
		length: value.length,
		bufferByteLength: value.buffer.byteLength
	}),

	arrayBuffer: (value) => value,

	arrayLength: (value) => value.length,

	hasOwnIndex: (value, index) => Object.hasOwn(value, index),

	arrayIndices: (value) => valid_array_indices(value),

	objectShape: (value) => {
		if (!is_plain_object(value)) return NOT_PLAIN;
		if (enumerable_symbols(value).length > 0) return SYMBOL_KEYS;

		return {
			kind: Object.getPrototypeOf(value) === null ? 'null-proto' : 'plain',
			keys: Object.keys(value)
		};
	},

	get: (value, key) => value[key]
});
