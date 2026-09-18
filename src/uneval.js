import { MAX_ARRAY_INDEX } from './constants.js';
import {
	DevalueError,
	enumerable_symbols,
	escaped,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_string,
	valid_array_indices
} from './utils.js';

const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
// Short strings have bounded escaping/output costs per reference, so they cannot
// cause quadratic expansion. Keep them on the original fast path rather than
// paying for deduplication on common values such as names, IDs and status fields.
const MIN_STRING_LENGTH = 128;
const unsafe_chars = /[<\b\f\n\r\t\0\u2028\u2029]/g;
const reserved =
	/^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;

/**
 * Turn a value into the JavaScript that creates an equivalent value
 * @param {any} value
 * @param {(value: any, uneval: (value: any) => string) => string | void} [replacer]
 */
export function uneval(value, replacer) {
	const counts = new Map();

	/** @type {string[]} */
	const keys = [];

	const custom = new Map();

	// Only allocate a literal cache when we need to reuse an expensive primitive,
	// including long Map keys rendered in error paths during the walk.
	/** @type {Map<string | bigint, string> | undefined} */
	let primitives;

	/** @param {any} thing */
	function stringify_cached_primitive(thing) {
		if (
			(typeof thing === 'string' && thing.length >= MIN_STRING_LENGTH) ||
			typeof thing === 'bigint'
		) {
			primitives ??= new Map();
			let literal = primitives.get(thing);
			if (literal === undefined) {
				literal = stringify_primitive(thing);
				primitives.set(thing, literal);
			}
			return literal;
		}
		return stringify_primitive(thing);
	}

	/** @param {any} thing */
	function walk(thing) {
		if (!is_primitive(thing)) {
			if (counts.has(thing)) {
				counts.set(thing, counts.get(thing) + 1);
				return;
			}

			counts.set(thing, 1);

			if (replacer) {
				const str = replacer(thing, (value) => uneval(value, replacer));

				if (typeof str === 'string') {
					custom.set(thing, str);
					return;
				}
			}

			if (typeof thing === 'function') {
				throw new DevalueError(`Cannot stringify a function`, keys, thing, value);
			}

			const type = get_type(thing);

			switch (type) {
				case 'BigInt':
				case 'String':
					walk(thing.valueOf());
					return;

				case 'Number':
				case 'Boolean':
				case 'Date':
				case 'RegExp':
				case 'URL':
				case 'URLSearchParams':
					return;

				case 'Array':
					// forEach scans the logical length of dictionary-backed sparse
					// arrays. Visit own enumerable indices without doing work for
					// every hole.
					for (const i of valid_array_indices(thing)) {
						keys.push(`[${i}]`);
						walk(thing[i]);
						keys.pop();
					}
					break;

				case 'Set':
					Array.from(thing).forEach(walk);
					break;

				case 'Map':
					for (const [key, value] of thing) {
						keys.push(`.get(${is_primitive(key) ? stringify_cached_primitive(key) : '...'})`);
						walk(key);
						walk(value);
						keys.pop();
					}
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
				case 'DataView':
					walk(thing.buffer);
					return;

				case 'ArrayBuffer':
					return;

				case 'Temporal.Duration':
				case 'Temporal.Instant':
				case 'Temporal.PlainDate':
				case 'Temporal.PlainTime':
				case 'Temporal.PlainDateTime':
				case 'Temporal.PlainMonthDay':
				case 'Temporal.PlainYearMonth':
				case 'Temporal.ZonedDateTime':
					return;

				default:
					if (!is_plain_object(thing)) {
						throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys, thing, value);
					}

					if (enumerable_symbols(thing).length > 0) {
						throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys, thing, value);
					}

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
						walk(thing[key]);
						keys.pop();
					}
			}
		} else if (typeof thing === 'symbol') {
			throw new DevalueError(`Cannot stringify a Symbol primitive`, keys, thing, value);
		} else if (
			(typeof thing === 'string' && thing.length >= MIN_STRING_LENGTH) ||
			typeof thing === 'bigint'
		) {
			counts.set(thing, (counts.get(thing) || 0) + 1);
		}
	}

	walk(value);

	const names = new Map();

	/** @type {Array<[any, number]>} */
	const repeated = [];
	// Avoid allocating entries for all the values that will never be hoisted.
	counts.forEach((count, thing) => {
		if (count > 1) repeated.push([thing, count]);
	});

	repeated
		.sort((a, b) => b[1] - a[1])
		.forEach(([thing, count]) => {
			const name = get_name(names.size);

			if (is_primitive(thing)) {
				const length = stringify_cached_primitive(thing).length;
				// Hoisting costs one literal, a parameter and a reference per occurrence.
				// Allow for the IIFE wrapper and separators even if one already exists,
				// so inexpensive repetitions stay inline.
				if (length * count <= length + (count + 1) * name.length + 25) return;
			}

			names.set(thing, name);
		});

	/**
	 * @param {any} thing
	 * @returns {string}
	 */
	function stringify(thing) {
		if (names.has(thing)) {
			return names.get(thing);
		}

		if (is_primitive(thing)) {
			return stringify_primitive(thing);
		}

		if (custom.has(thing)) {
			return custom.get(thing);
		}

		const type = get_type(thing);

		switch (type) {
			case 'Number':
			case 'String':
			case 'Boolean':
			case 'BigInt':
				return `Object(${stringify(thing.valueOf())})`;

			case 'RegExp':
				const { source, flags } = thing;
				return flags
					? `new RegExp(${stringify_string(source)},"${flags}")`
					: `new RegExp(${stringify_string(source)})`;

			case 'Date':
				return `new Date(${thing.getTime()})`;

			case 'URL':
				return `new URL(${stringify_string(thing.toString())})`;

			case 'URLSearchParams':
				return `new URLSearchParams(${stringify_string(thing.toString())})`;

			case 'Array': {
				// For dense arrays (no holes), we iterate normally.
				// When we encounter the first hole, we collect own indices
				// to determine the sparseness, then decide between:
				//   - Array literal with holes: [,"a",,] (default)
				//   - Object.assign with a sparse-safe allocator (for very sparse arrays)
				// Only the Object.assign path avoids iterating every slot, which
				// is what protects against the DoS of e.g. `arr[1000000] = 1`.
				let has_holes = false;

				let result = '[';

				for (let i = 0; i < thing.length; i += 1) {
					if (i > 0) result += ',';

					if (Object.hasOwn(thing, i)) {
						result += stringify(thing[i]);
					} else if (!has_holes) {
						// Decide between array literal and Object.assign.
						//
						// Array literal: holes are consecutive commas.
						// For example, [, "a", ,] is written as [,"a",,].
						// Each hole costs 1 char (a comma).
						//
						// Object.assign: populated indices are listed explicitly.
						// For example, [, "a", ,] would be written as
						// Object.assign(sparse(3),{1:"a"}), where sparse(n) stands
						// for the expression emitted by stringify_sparse_array(n).
						// This avoids paying per-hole, but has a large fixed
						// overhead for the allocator and Object.assign wrapper,
						// and each element costs extra chars for its index and colon.
						//
						// The serialized values are the same size either way, so
						// the choice comes down to the structural overhead:
						//
						//   Array literal overhead:
						//     1 char per element or hole (comma separators)
						//     + 2 chars for "[" and "]"
						//     = L + 2
						//
						//   Object.assign overhead:
						//     "Object.assign("      — 14 chars
						//     + allocator expression — A chars
						//     + ",{"                 — 2 chars
						//     + for each populated element:
						//       index + ":" + ","     — (d + 2) chars
						//     + "})"                 — 2 chars
						//     = (18 + A) + P * (d + 2)
						//
						// where L is the array length, P is the number of
						// populated elements, A is the allocator expression's
						// length, and d is the number of digits in L (an upper
						// bound on the digits in any index).
						//
						// Object.assign is cheaper when:
						//   (18 + A) + P * (d + 2) < L + 2
						const populated_keys = valid_array_indices(thing);
						const population = populated_keys.length;
						const d = String(thing.length).length;
						const array = stringify_sparse_array(thing.length);

						const hole_cost = thing.length + 2;
						const sparse_cost = array.length + 18 + population * (d + 2);

						if (hole_cost > sparse_cost) {
							const entries = populated_keys.map((k) => `${k}:${stringify(thing[k])}`).join(',');
							return `Object.assign(${array},{${entries}})`;
						}

						has_holes = true;
					}
					// else: already decided on array literal, hole is just an empty slot
					// (the comma separator is all we need — no content for this position)
				}

				const tail = thing.length === 0 || Object.hasOwn(thing, thing.length - 1) ? '' : ',';
				return result + tail + ']';
			}

			case 'Set':
			case 'Map':
				return `new ${type}([${Array.from(thing).map(stringify).join(',')}])`;

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
				let str = `new ${type}`;

				if (!names.has(thing.buffer)) {
					str += `([${stringify_typed_array_elements(type, thing.buffer)}])`;
				} else {
					str += `(${stringify(thing.buffer)})`;
				}

				// handle subarrays
				if (thing.byteLength !== thing.buffer.byteLength) {
					const start = thing.byteOffset / thing.BYTES_PER_ELEMENT;
					const end = start + thing.length;
					str += `.subarray(${start},${end})`;
				}

				return str;
			}

			case 'DataView': {
				let str = `new DataView`;

				if (!names.has(thing.buffer)) {
					str += `(new Uint8Array([${new Uint8Array(thing.buffer)}]).buffer`;
				} else {
					str += `(${stringify(thing.buffer)}`;
				}

				// handle subviews
				if (thing.byteLength !== thing.buffer.byteLength) {
					str += `,${thing.byteOffset},${thing.byteLength}`;
				}

				return str + ')';
			}

			case 'ArrayBuffer': {
				const ui8 = new Uint8Array(thing);
				return `new Uint8Array([${ui8.toString()}]).buffer`;
			}

			case 'Temporal.Duration':
			case 'Temporal.Instant':
			case 'Temporal.PlainDate':
			case 'Temporal.PlainTime':
			case 'Temporal.PlainDateTime':
			case 'Temporal.PlainMonthDay':
			case 'Temporal.PlainYearMonth':
			case 'Temporal.ZonedDateTime':
				return `${type}.from(${stringify_string(thing.toString())})`;

			default:
				const keys = Object.keys(thing);
				const obj = keys.map((key) => `${safe_key(key)}:${stringify(thing[key])}`).join(',');
				const proto = Object.getPrototypeOf(thing);
				if (proto === null) {
					return keys.length > 0 ? `{${obj},__proto__:null}` : `{__proto__:null}`;
				}

				return `{${obj}}`;
		}
	}

	const str = stringify(value);

	if (names.size) {
		/** @type {string[]} */
		const params = [];

		/** @type {string[]} */
		const statements = [];

		/** @type {string[]} */
		const values = [];

		// Reconstructions (e.g. `b = new Uint8Array(...)`) reassign a placeholder
		// parameter. They must run before the `statements` that reference them,
		// otherwise those statements capture the placeholder. They only depend on
		// IIFE arguments (never on each other), so emitting them first is safe.
		/** @type {string[]} */
		const reconstructions = [];

		names.forEach((name, thing) => {
			params.push(name);

			if (custom.has(thing)) {
				values.push(/** @type {string} */ (custom.get(thing)));
				return;
			}

			if (is_primitive(thing)) {
				values.push(stringify_cached_primitive(thing));
				return;
			}

			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'BigInt': {
					const primitive = thing.valueOf();
					if (names.has(primitive)) {
						// A hoisted primitive is only in scope inside the IIFE, not in
						// its arguments. Reconstruct the box before assigning references.
						values.push('{}');
						reconstructions.push(`${name}=Object(${stringify(primitive)})`);
					} else {
						values.push(`Object(${stringify(primitive)})`);
					}
					break;
				}

				case 'RegExp':
					const { source, flags } = thing;
					const regexp = flags
						? `new RegExp(${stringify_string(source)},"${flags}")`
						: `new RegExp(${stringify_string(source)})`
					values.push(regexp);
					break;

				case 'Date':
					values.push(`new Date(${thing.getTime()})`);
					break;

				case 'URL':
					values.push(`new URL(${stringify_string(thing.toString())})`);
					break;

				case 'URLSearchParams':
					values.push(`new URLSearchParams(${stringify_string(thing.toString())})`);
					break;

				case 'Array': {
					const populated_keys = valid_array_indices(thing);
					// Only preallocate when the length is bounded by the number
					// of populated elements, plus a small constant for short arrays.
					values.push(
						thing.length > 32 + 2 * populated_keys.length
							? stringify_sparse_array(thing.length)
							: `Array(${thing.length})`
					);
					for (const i of populated_keys) {
						statements.push(`${name}[${i}]=${stringify(thing[i])}`);
					}
					break;
				}

				case 'Set': {
					values.push(`new Set`);
					const adds = Array.from(thing).map((v) => `.add(${stringify(v)})`);
					// An empty Set is fully built by `new Set`; a chained statement would
					// otherwise be a dangling `name.`.
					if (adds.length > 0) statements.push(name + adds.join(''));
					break;
				}

				case 'Map': {
					values.push(`new Map`);
					const sets = Array.from(thing).map(
						([k, v]) => `.set(${stringify(k)}, ${stringify(v)})`
					);
					if (sets.length > 0) statements.push(name + sets.join(''));
					break;
				}

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
					let str = `new ${type}`;

					if (!names.has(thing.buffer)) {
						str += `([${stringify_typed_array_elements(type, thing.buffer)}])`;
					} else {
						str += `(${stringify(thing.buffer)})`;
					}

					// handle subarrays
					if (thing.byteLength !== thing.buffer.byteLength) {
						const start = thing.byteOffset / thing.BYTES_PER_ELEMENT;
						const end = start + thing.length;
						str += `.subarray(${start},${end})`;
					}

					values.push(`{}`);
					reconstructions.push(`${name}=${str}`);
					break;
				}

				case 'DataView': {
					let str = `new DataView`;

					if (!names.has(thing.buffer)) {
						str += `(new Uint8Array([${new Uint8Array(thing.buffer)}]).buffer`;
					} else {
						str += `(${stringify(thing.buffer)}`;
					}

					// handle subviews
					if (thing.byteLength !== thing.buffer.byteLength) {
						str += `,${thing.byteOffset},${thing.byteLength}`;
					}

					str += ')';

					values.push(`{}`);
					reconstructions.push(`${name}=${str}`);
					break;
				}

				case 'ArrayBuffer':
					values.push(`new Uint8Array([${new Uint8Array(thing)}]).buffer`);
					break;

				case 'Temporal.Duration':
				case 'Temporal.Instant':
				case 'Temporal.PlainDate':
				case 'Temporal.PlainTime':
				case 'Temporal.PlainDateTime':
				case 'Temporal.PlainMonthDay':
				case 'Temporal.PlainYearMonth':
				case 'Temporal.ZonedDateTime':
					values.push(`${type}.from(${stringify_string(thing.toString())})`);
					break;

				default:
					values.push(Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}');
					Object.keys(thing).forEach((key) => {
						statements.push(`${name}${safe_prop(key)}=${stringify(thing[key])}`);
					});
			}
		});

		statements.push(`return ${str}`);

		const body = [...reconstructions, ...statements].join(';');
		// A function may have at most 65535 parameters (and a call at most that
		// many arguments). For very large graphs, pass the hoisted values as a
		// single array argument and destructure them into the placeholder names,
		// so the emitted code stays within the engine limit (#93).
		if (params.length > 65534) {
			return `(function(){var[${params.join(',')}]=arguments[0];${body}}([${values.join(',')}]))`;
		}

		return `(function(${params.join(',')}){${body}}(${values.join(',')}))`;
	} else {
		return str;
	}
}

/**
 * Emit an array whose storage is not proportional to its declared length.
 * As in the default parse operations, touching and deleting the largest valid
 * index forces V8 into dictionary-elements mode before setting the length.
 * Merely starting with [] and assigning .length still eagerly allocates.
 * @param {number} length
 */
function stringify_sparse_array(length) {
	return `(function(a){a[${MAX_ARRAY_INDEX}]=0;delete a[${MAX_ARRAY_INDEX}];a.length=${length};return a}([]))`;
}

/**
 * Serialize the elements of `buffer`, read as `type`, as a comma-separated list.
 * The view is created from `type` rather than from the serialized value's own
 * constructor, which may be a subclass like Node's `Buffer` whose `toString`
 * decodes the bytes instead of listing them.
 * `BigInt64Array`/`BigUint64Array` elements are bigints and must be written
 * with an `n` suffix, otherwise the emitted `new BigInt64Array([...])` throws.
 * @param {string} type
 * @param {ArrayBufferLike} buffer
 */
function stringify_typed_array_elements(type, buffer) {
	const array = new (/** @type {any} */ (globalThis)[type])(buffer);

	if (type === 'BigInt64Array' || type === 'BigUint64Array') {
		return Array.from(array, (element) => `${element}n`).join(',');
	}

	// Float arrays can hold `-0`, which `toString()` collapses to `"0"`, silently
	// losing the sign on round-trip. Emit `-0` explicitly for those elements.
	if (
		array instanceof Float32Array ||
		array instanceof Float64Array ||
		(typeof Float16Array !== 'undefined' && array instanceof Float16Array)
	) {
		return Array.from(array, (element) => (Object.is(element, -0) ? '-0' : `${element}`)).join(',');
	}

	return array.toString();
}

/** @param {number} num */
function get_name(num) {
	let name = '';

	do {
		name = chars[num % chars.length] + name;
		num = ~~(num / chars.length) - 1;
	} while (num >= 0);

	return reserved.test(name) ? `${name}0` : name;
}

/** @param {string} c */
function escape_unsafe_char(c) {
	return escaped[c] || c;
}

/** @param {string} str */
function escape_unsafe_chars(str) {
	return str.replace(unsafe_chars, escape_unsafe_char);
}

/** @param {string} key */
function safe_key(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? key : escape_unsafe_chars(JSON.stringify(key));
}

/** @param {string} key */
function safe_prop(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key)
		? `.${key}`
		: `[${escape_unsafe_chars(JSON.stringify(key))}]`;
}

/** @param {any} thing */
function stringify_primitive(thing) {
	const type = typeof thing;
	if (type === 'string') return stringify_string(thing);
	if (thing === void 0) return 'void 0';
	if (thing === 0 && 1 / thing < 0) return '-0';
	const str = String(thing);
	if (type === 'number') return str.replace(/^(-)?0\./, '$1.');
	if (type === 'bigint') return thing + 'n';
	return str;
}
