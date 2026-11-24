import { DevalueError, MAP_KEY, format_path, quote_key, stringify_string } from './utils.js';
import {
	NAN,
	NEGATIVE_INFINITY,
	NEGATIVE_ZERO,
	POSITIVE_INFINITY,
	UNDEFINED
} from './constants.js';
import { encode64 } from './base64.js';
import { default_stringify_operations, merge_operations } from './operations.js';

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @param {import('./types.js').StringifyOptions} [options]
 */
export function stringify(value, reducers, options) {
	const stringified = run(false, value, reducers, options);
	return typeof stringified === 'string' ? stringified : `[${stringified.join(',')}]`;
}

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @param {import('./types.js').StringifyOptions} [options]
 */
export async function stringifyAsync(value, reducers, options) {
	const stringified = run(true, value, reducers, options);

	if (typeof stringified === 'string') {
		return stringified;
	}

	let out = '[';

	for (let i = 0; i < stringified.length; i += 1) {
		let value = stringified[i];

		if (typeof value !== 'string') {
			await value;
			value = stringified[i];

			if (i === 0 && value < 0) {
				return `${value}`;
			}
		}

		out += value;

		if (i < stringified.length - 1) {
			out += ',';
		}
	}

	out += ']';

	return out;
}

/**
 * @param {boolean} async
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @param {import('./types.js').StringifyOptions} [options]
 */
function run(async, value, reducers, options) {
	const ops = merge_operations(default_stringify_operations, options?.operations);

	/** @type {any[]} */
	const stringified = [];

	const references = options?.references ?? true;

	/** @type {Map<any, number>} */
	const indexes = new Map();

	/**
	 * ids on the current path, used to reject cycles when references is false
	 * @type {Set<any>}
	 */
	let ancestors = new Set();

	/** @type {Array<{ key: string, fn: (value: any) => any }>} */
	const custom = [];
	if (reducers) {
		for (const key of Object.getOwnPropertyNames(reducers)) {
			custom.push({ key, fn: reducers[key] });
		}
	}

	// the path to the value being serialized, recorded as-is and only
	// formatted by `error` — see `format_path`
	/** @type {any[]} */
	let keys = [];

	let p = 0;

	/**
	 * @param {string} message
	 * @param {any} thing
	 * @returns {never}
	 */
	function error(message, thing) {
		const path = format_path(keys, (key) => {
			const key_type = ops.typeOf(key);
			const key_is_primitive =
				key_type !== 'object' && key_type !== 'function' && key_type !== 'symbol';
			return key_is_primitive ? stringify_primitive(ops.toPrimitive(key)) : '...';
		});

		throw new DevalueError(message, path, thing, value);
	}

	/**
	 * @param {any} thing
	 * @param {number} [index]
	 */
	function flatten(thing, index) {
		const type = ops.typeOf(thing);

		if (type === 'undefined') return UNDEFINED;

		/** @type {number | undefined} */
		let number;

		// `ops.toPrimitive` is the boundary between the value being serialized and
		// plain host JavaScript: everything below operates on the extracted host
		// primitive, so native comparisons and arithmetic are correct there.
		if (type === 'number') {
			number = /** @type {number} */ (ops.toPrimitive(thing));
			if (Number.isNaN(number)) return NAN;
			if (number === Infinity) return POSITIVE_INFINITY;
			if (number === -Infinity) return NEGATIVE_INFINITY;
			if (number === 0 && 1 / number < 0) return NEGATIVE_ZERO;
		}

		const id = ops.identify(thing);

		if (references) {
			const existing = indexes.get(id);
			if (existing !== undefined) return existing;
		}

		// without reducers, only objects can lead back to themselves
		const tracked = !references && (type === 'object' || custom.length > 0);

		if (tracked) {
			if (ancestors.has(id)) {
				error(`Cannot stringify a circular reference when \`references\` is \`false\``, thing);
			}
			ancestors.add(id);
		}

		index ??= p++;
		if (references) indexes.set(id, index);

		for (const { key, fn } of custom) {
			const value = fn(thing);
			if (value) {
				stringified[index] = `["${key}",${flatten(value)}]`;
				if (tracked) ancestors.delete(id);
				return index;
			}
		}

		if (type === 'function') {
			error(`Cannot stringify a function`, thing);
		} else if (type === 'symbol') {
			error(`Cannot stringify a Symbol primitive`, thing);
		}

		/** @type {string | Promise<any>} */
		let str = '';

		if (type !== 'object') {
			str = stringify_primitive(type === 'number' ? number : ops.toPrimitive(thing));
		} else if (ops.isThenable(thing)) {
			if (!async) {
				error(`Cannot stringify a Promise or thenable — use stringifyAsync instead`, thing);
			}

			// the callback runs after the synchronous walk has unwound `keys`,
			// so the path to the thenable has to be captured and reinstated
			const prev_keys = keys.slice();
			// likewise the ancestors, so a thenable resolving to its own container is a cycle
			const prev_ancestors = references ? null : new Set(ancestors);

			str = ops.toPromise(thing).then((value) => {
				keys = prev_keys;
				if (prev_ancestors) ancestors = prev_ancestors;

				const i = flatten(value, index);
				if (i < 0) stringified[index] = i;
			});

			// Promises are awaited sequentially, and traversal may throw before
			// reaching them. Handle rejections immediately, but keep the original
			// promise so awaiting it still propagates the error to the caller.
			str.catch(() => {});
		} else {
			const tag = ops.tagOf(thing);

			switch (tag) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'BigInt':
					str = `["Object",${flatten(ops.unbox(thing))}]`;
					break;

				case 'Date':
					str = `["Date","${ops.toISOString(thing)}"]`;
					break;

				case 'URL':
					str = `["URL",${stringify_string(ops.toStringValue(thing))}]`;
					break;

				case 'URLSearchParams':
					str = `["URLSearchParams",${stringify_string(ops.toStringValue(thing))}]`;
					break;

				case 'RegExp':
					error(`Cannot stringify a RegExp`, thing);

				case 'Array': {
					const length = ops.lengthOf(thing);
					str = '[';

					for (let i = 0; i < length; i += 1) {
						if (!ops.hasOwn(thing, i)) {
							error(`Cannot stringify a sparse array`, thing);
						}

						if (i > 0) str += ',';
						keys.push(i);
						str += flatten(ops.get(thing, i));
						keys.pop();
					}

					str += ']';
					break;
				}

				case 'Set':
					str = '["Set"';

					for (const value of ops.valuesOf(thing)) {
						str += `,${flatten(value)}`;
					}

					str += ']';
					break;

				case 'Map':
					str = '["Map"';

					for (const [key, value] of ops.entriesOf(thing)) {
						keys.push(MAP_KEY, key);
						str += `,${flatten(key)},${flatten(value)}`;
						keys.pop();
						keys.pop();
					}

					str += ']';
					break;

				case 'Int8Array':
				case 'Uint8Array':
				case 'Uint8ClampedArray':
				case 'Int16Array':
				case 'Uint16Array':
				case 'Float16Array':
				case 'Int32Array':
				case 'Uint32Array':
				case 'Float32Array':
				case 'Float64Array':
				case 'BigInt64Array':
				case 'BigUint64Array': {
					const info = ops.viewInfo(thing);
					str = '["' + tag + '",' + flatten(info.buffer);

					// handle subarrays
					if (info.byteLength !== info.bufferByteLength) {
						str += `,${info.byteOffset},${info.length}`;
					}

					str += ']';
					break;
				}

				case 'DataView': {
					const info = ops.viewInfo(thing);
					str = '["' + tag + '",' + flatten(info.buffer);

					if (info.byteLength !== info.bufferByteLength) {
						str += `,${info.byteOffset},${info.byteLength}`;
					}

					str += ']';
					break;
				}

				case 'ArrayBuffer': {
					const base64 = encode64(ops.toArrayBuffer(thing));

					str = `["ArrayBuffer","${base64}"]`;
					break;
				}

				case 'Temporal.Duration':
				case 'Temporal.Instant':
				case 'Temporal.PlainDate':
				case 'Temporal.PlainTime':
				case 'Temporal.PlainDateTime':
				case 'Temporal.PlainMonthDay':
				case 'Temporal.PlainYearMonth':
				case 'Temporal.ZonedDateTime':
					str = `["${tag}",${stringify_string(ops.toStringValue(thing))}]`;
					break;

				default: {
					const shape = ops.shapeOf(thing);

					if (shape.kind === 'not-plain') {
						error(`Cannot stringify arbitrary non-POJOs`, thing);
					}

					if (shape.kind === 'symbol-keys') {
						error(`Cannot stringify POJOs with symbolic keys`, thing);
					}

					if (shape.kind === 'null-proto') {
						str = '["null"';
						for (const key of shape.keys) {
							if (key === '__proto__') {
								error(`Cannot stringify objects with __proto__ keys`, thing);
							}

							keys.push(key);
							str += `,${quote_key(key)},${flatten(ops.get(thing, key))}`;
							keys.pop();
						}
						str += ']';
					} else {
						str = '{';
						let started = false;
						for (const key of shape.keys) {
							if (key === '__proto__') {
								error(`Cannot stringify objects with __proto__ keys`, thing);
							}

							if (started) str += ',';
							started = true;
							keys.push(key);
							str += `${quote_key(key)}:${flatten(ops.get(thing, key))}`;
							keys.pop();
						}
						str += '}';
					}
				}
			}
		}

		stringified[index] = str;
		if (tracked) ancestors.delete(id);
		return index;
	}

	const index = flatten(value);

	// special case — value is represented as a negative index
	if (index < 0) return `${index}`;

	return stringified;
}

/**
 * @param {any} thing
 * @returns {string}
 */
function stringify_primitive(thing) {
	const type = typeof thing;
	if (type === 'string') return stringify_string(thing);
	if (thing === void 0) return UNDEFINED.toString();
	if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO.toString();
	if (type === 'bigint') return `["BigInt","${thing}"]`;
	return String(thing);
}
