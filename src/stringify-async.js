import {
	DevalueError,
	enumerable_symbols,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_string,
	valid_array_indices
} from './utils.js';
import {
	HOLE,
	NAN,
	NEGATIVE_INFINITY,
	NEGATIVE_ZERO,
	POSITIVE_INFINITY,
	SPARSE,
	UNDEFINED
} from './constants.js';
import { encode64 } from './base64.js';

/**
 * Async version of `stringify` that resolves promises in the value graph
 * and supports async reducers. Returns a JSON string in the same format
 * as `stringify`, so `parse` and `unflatten` work unchanged.
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @returns {Promise<string>}
 */
export async function stringifyAsync(value, reducers) {
	/** @type {any[]} */
	const stringified = [];

	/** @type {Map<any, number>} */
	const indexes = new Map();

	/** @type {Array<{ key: string, fn: (value: any) => any }>} */
	const custom = [];
	if (reducers) {
		for (const key of Object.getOwnPropertyNames(reducers)) {
			custom.push({ key, fn: reducers[key] });
		}
	}

	/** @type {string[]} */
	const keys = [];

	let p = 0;

	/** @param {any} thing */
	async function flatten(thing) {
		// Resolve thenables/Promises before processing
		if (thing !== null && typeof thing === 'object' && typeof thing.then === 'function') {
			thing = await thing;
		}

		if (thing === undefined) return UNDEFINED;
		if (Number.isNaN(thing)) return NAN;
		if (thing === Infinity) return POSITIVE_INFINITY;
		if (thing === -Infinity) return NEGATIVE_INFINITY;
		if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO;

		if (indexes.has(thing)) return /** @type {number} */ (indexes.get(thing));

		const index = p++;
		indexes.set(thing, index);

		for (const { key, fn } of custom) {
			let value = fn(thing);
			// Allow reducers to return Promises
			if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
				value = await value;
			}
			if (value) {
				stringified[index] = `["${key}",${await flatten(value)}]`;
				return index;
			}
		}

		if (typeof thing === 'function') {
			throw new DevalueError(`Cannot stringify a function`, keys, thing, value);
		} else if (typeof thing === 'symbol') {
			throw new DevalueError(`Cannot stringify a Symbol primitive`, keys, thing, value);
		}

		let str = '';

		if (is_primitive(thing)) {
			str = stringify_primitive(thing);
		} else {
			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'BigInt':
					str = `["Object",${await flatten(thing.valueOf())}]`;
					break;

				case 'Date':
					const valid = !isNaN(thing.getDate());
					str = `["Date","${valid ? thing.toISOString() : ''}"]`;
					break;

				case 'URL':
					str = `["URL",${stringify_string(thing.toString())}]`;
					break;

				case 'URLSearchParams':
					str = `["URLSearchParams",${stringify_string(thing.toString())}]`;
					break;

				case 'RegExp':
					const { source, flags } = thing;
					str = flags
						? `["RegExp",${stringify_string(source)},"${flags}"]`
						: `["RegExp",${stringify_string(source)}]`;
					break;

				case 'Array': {
					let mostly_dense = false;

					str = '[';

					for (let i = 0; i < thing.length; i += 1) {
						if (i > 0) str += ',';

						if (Object.hasOwn(thing, i)) {
							keys.push(`[${i}]`);
							str += await flatten(thing[i]);
							keys.pop();
						} else if (mostly_dense) {
							str += HOLE;
						} else {
							const populated_keys = valid_array_indices(/** @type {any[]} */ (thing));
							const population = populated_keys.length;
							const d = String(thing.length).length;

							const hole_cost = (thing.length - population) * 3;
							const sparse_cost = 4 + d + population * (d + 1);

							if (hole_cost > sparse_cost) {
								str = '[' + SPARSE + ',' + thing.length;
								for (let j = 0; j < populated_keys.length; j++) {
									const key = populated_keys[j];
									keys.push(`[${key}]`);
									str += ',' + key + ',' + (await flatten(thing[key]));
									keys.pop();
								}
								break;
							} else {
								mostly_dense = true;
								str += HOLE;
							}
						}
					}

					str += ']';

					break;
				}

				case 'Set':
					str = '["Set"';

					for (const value of thing) {
						str += `,${await flatten(value)}`;
					}

					str += ']';
					break;

				case 'Map':
					str = '["Map"';

					for (const [key, value] of thing) {
						keys.push(`.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`);
						str += `,${await flatten(key)},${await flatten(value)}`;
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
				case 'BigUint64Array':
				case 'DataView': {
					/** @type {import("./types.js").TypedArray} */
					const typedArray = thing;
					str = '["' + type + '",' + (await flatten(typedArray.buffer));

					// handle subarrays
					if (typedArray.byteLength !== typedArray.buffer.byteLength) {
						// to be used with `new TypedArray(buffer, byteOffset, length)`
						str += `,${typedArray.byteOffset},${typedArray.length}`;
					}

					str += ']';
					break;
				}

				case 'ArrayBuffer': {
					/** @type {ArrayBuffer} */
					const arraybuffer = thing;
					const base64 = encode64(arraybuffer);

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
					str = `["${type}",${stringify_string(thing.toString())}]`;
					break;

				default:
					if (!is_plain_object(thing)) {
						throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys, thing, value);
					}

					if (enumerable_symbols(thing).length > 0) {
						throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys, thing, value);
					}

					if (Object.getPrototypeOf(thing) === null) {
						str = '["null"';
						for (const key of Object.keys(thing)) {
							if (key === '__proto__') {
								throw new DevalueError(
									`Cannot stringify objects with __proto__ keys`,
									keys,
									thing,
									value
								);
							}

							keys.push(stringify_key(key));
							str += `,${stringify_string(key)},${await flatten(thing[key])}`;
							keys.pop();
						}
						str += ']';
					} else {
						str = '{';
						let started = false;
						for (const key of Object.keys(thing)) {
							if (key === '__proto__') {
								throw new DevalueError(
									`Cannot stringify objects with __proto__ keys`,
									keys,
									thing,
									value
								);
							}

							if (started) str += ',';
							started = true;
							keys.push(stringify_key(key));
							str += `${stringify_string(key)}:${await flatten(thing[key])}`;
							keys.pop();
						}
						str += '}';
					}
			}
		}

		stringified[index] = str;
		return index;
	}

	const index = await flatten(value);

	// special case — value is represented as a negative index
	if (index < 0) return `${index}`;

	return `[${stringified.join(',')}]`;
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
