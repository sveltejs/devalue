import { MAX_ARRAY_INDEX } from './constants.js';
import { filter_array_indices } from './utils.js';

/** @param {any[]} array */
function array_indices(array) {
	return filter_array_indices(Object.getOwnPropertyNames(array));
}

const regexp_source = /** @type {() => string} */ (
	Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get
);
const regexp_flags = /** @type {() => string} */ (
	Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')?.get
);

/** @param {unknown} value */
function regexp_info(value) {
	try {
		return { source: regexp_source.call(value), flags: regexp_flags.call(value) };
	} catch {
		return null;
	}
}

/**
 * Opt-in `uneval` replacer for regular expressions.
 * @param {unknown} value
 * @param {import('./types.js').JavaScriptTag} tag
 */
export function regexp_replacer(value, tag) {
	const info = regexp_info(value);
	if (!info) return;
	return tag`new RegExp(${info.source},${info.flags})`;
}

/** @param {unknown} value */
export function regexp_reducer(value) {
	const info = regexp_info(value);
	return info && [info.source, info.flags];
}

/** @param {unknown} value */
export function regexp_reviver(value) {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		typeof value[0] !== 'string' ||
		typeof value[1] !== 'string'
	) {
		throw new Error('Invalid RegExp encoding');
	}

	return new RegExp(value[0], value[1]);
}

/**
 * Opt-in `uneval` replacer for sparse arrays.
 * @param {unknown} value
 * @param {import('./types.js').JavaScriptTag} tag
 */
export function sparse_array_replacer(value, tag) {
	if (!Array.isArray(value)) return;

	const indices = array_indices(value);
	if (indices.length === value.length) return;

	const pairs = indices.map((index) => [index, value[+index]]);
	if (pairs.some((entry) => entry[1] === value)) {
		throw new Error('Cannot serialize a cyclic sparse array');
	}
	const entries = Object.fromEntries(pairs);
	return tag`Object.assign((function(a,l){a[${MAX_ARRAY_INDEX}]=0;delete a[${MAX_ARRAY_INDEX}];a.length=l;return a})([],${value.length}),${entries})`;
}

/** @param {unknown} value */
export function sparse_array_reducer(value) {
	if (!Array.isArray(value)) return false;

	const indices = array_indices(value);
	if (indices.length === value.length) return false;

	const entries = indices.map((index) => [+index, value[+index]]);
	if (entries.some((entry) => entry[1] === value)) {
		throw new Error('Cannot serialize a cyclic sparse array');
	}
	return [value.length, entries];
}

/** @param {unknown} value */
export function sparse_array_reviver(value) {
	if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])) {
		throw new Error('Invalid sparse array encoding');
	}

	const length = value[0];
	if (!Number.isInteger(length) || length < 0 || length > MAX_ARRAY_INDEX + 1) {
		throw new Error('Invalid sparse array encoding');
	}

	/** @type {any[]} */
	const array = [];
	array[MAX_ARRAY_INDEX] = undefined;
	delete array[MAX_ARRAY_INDEX];
	array.length = length;

	for (const entry of value[1]) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			!Number.isInteger(entry[0]) ||
			entry[0] < 0 ||
			entry[0] >= length ||
			Object.hasOwn(array, entry[0])
		) {
			throw new Error('Invalid sparse array encoding');
		}

		array[entry[0]] = entry[1];
	}

	return array;
}

/**
 * An `uneval` replacer enabling both opt-in unsafe types.
 * @param {unknown} value
 * @param {import('./types.js').JavaScriptTag} tag
 */
export function unsafe_replacer(value, tag) {
	return regexp_replacer(value, tag) || sparse_array_replacer(value, tag);
}

/** Reducers enabling both opt-in unsafe types for `stringify`. */
export const unsafe_reducers = /* @__PURE__ */ Object.freeze({
	RegExp: regexp_reducer,
	SparseArray: sparse_array_reducer
});

/** Revivers enabling both opt-in unsafe types for `parse` and `unflatten`. */
export const unsafe_revivers = /* @__PURE__ */ Object.freeze({
	RegExp: regexp_reviver,
	SparseArray: sparse_array_reviver
});
