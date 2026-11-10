/**
 * @import { UnevalReplacer } from './types.js';
 */
import { js, JavaScriptSource } from './javascript-source.js';
import {
	DevalueError,
	MAP_KEY,
	enumerable_symbols,
	escaped,
	format_path,
	get_name,
	get_type,
	is_buffer,
	is_plain_object,
	is_primitive,
	stringify_sparse_array,
	stringify_string,
	valid_array_indices
} from './utils.js';

const unsafe_chars = /[<\b\f\n\r\t\0\u2028\u2029]/g;
// Short strings have bounded escaping/output costs per reference.
const MIN_STRING_LENGTH = 128;

/**
 * Turn a value into the JavaScript that creates an equivalent value
 * @param {any} value
 * @param {UnevalReplacer} [replacer]
 */
export function uneval(value, replacer) {
	// Acyclic trees of JSON.stringify-able data need no reference counting,
	// so try to serialize them in a single pass first. If that pass meets anything
	// else, the general algorithm below takes over from where it stopped.
	const plain = new PlainSerializer(replacer);
	const result = plain.serialize(value);
	if (result !== null) return result;

	/** @type {Map<any, string>} */
	const names = new Map();
	const reserved = new Set();
	const templates = new Set();
	// everything the fast pass visited has been seen exactly once. Things
	// visited from here on are added with an id of -1
	const visited = plain.ids;

	// the path to the value being walked, recorded as-is and only formatted
	// by `error` — see `format_path`
	/** @type {any[]} */
	const keys = [];

	/** @type {Map<any, JavaScriptSource>} */
	const custom = new Map();

	/**
	 * @param {string} message
	 * @param {any} thing
	 * @returns {never}
	 */
	function error(message, thing) {
		const path = format_path(keys, (key) => (is_primitive(key) ? stringify_primitive(key) : '...'));
		throw new DevalueError(message, path, thing, value);
	}

	/** @type {Map<string | bigint, number> | undefined} */
	let primitive_counts;
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
			if (visited.has(thing)) {
				if (!names.has(thing)) names.set(thing, '');
				return;
			}

			visited.set(thing, -1);

			if (replacer) {
				const fragment = plain.replaced.has(thing)
					? plain.replaced.get(thing)
					: replacer(thing, js);

				if (fragment) {
					const source = JavaScriptSource.from(fragment);
					custom.set(thing, source);
					source.visit(walk, reserved, templates);
					return;
				}

				if (fragment !== undefined && fragment !== null && fragment !== false) {
					throw new TypeError('Invalid uneval replacer result');
				}
			}

			if (typeof thing === 'function') {
				error(`Cannot stringify a function`, thing);
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
					// Never scan the logical length of a dictionary-backed sparse array.
					for (const i of valid_array_indices(thing)) {
						keys.push(+i);
						walk(thing[i]);
						keys.pop();
					}
					break;

				case 'Set':
					for (const value of thing) walk(value);
					break;

				case 'Map':
					for (const [key, value] of thing) {
						keys.push(MAP_KEY, key);
						walk(key);
						walk(value);
						keys.pop();
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
					// Buffer pools can contain unrelated, sensitive bytes.
					if (!is_buffer(thing)) walk(thing.buffer);
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
						error(`Cannot stringify arbitrary non-POJOs`, thing);
					}

					if (enumerable_symbols(thing).length > 0) {
						error(`Cannot stringify POJOs with symbolic keys`, thing);
					}

					for (const key of Object.keys(thing)) {
						if (key === '__proto__') {
							error(`Cannot stringify objects with __proto__ keys`, thing);
						}

						keys.push(key);
						walk(thing[key]);
						keys.pop();
					}
			}
		} else if (typeof thing === 'symbol') {
			error(`Cannot stringify a Symbol primitive`, thing);
		} else if (
			(typeof thing === 'string' && thing.length >= MIN_STRING_LENGTH) ||
			typeof thing === 'bigint'
		) {
			primitive_counts ??= new Map();
			primitive_counts.set(thing, (primitive_counts.get(thing) || 0) + 1);
		}
	}

	for (const string of plain.long_strings) {
		(primitive_counts ??= new Map()).set(string, 1);
	}

	const { frames } = plain;

	if (frames.length === 0) {
		walk(value);
	} else {
		// `frames` holds the containers the fast pass was inside when it stopped,
		// innermost first. Everything before the position recorded in each has
		// been visited, so only the rest needs to be walked.
		for (let i = frames.length - 1; i >= 0; i -= 1) keys.push(frames[i].key);

		for (let i = 0; i < frames.length; i += 1) {
			keys.pop();
			const { thing, index } = frames[i];
			// the fast pass never started the innermost frame's current child,
			// whereas the outer frames' current children are the inner frames
			const start = i === 0 ? index : index + 1;

			if (Array.isArray(thing)) {
				for (const key of valid_array_indices(thing)) {
					const index = +key;
					if (index < start) continue;
					keys.push(index);
					walk(thing[index]);
					keys.pop();
				}
			} else {
				const object_keys = Object.keys(thing);
				for (let j = start; j < object_keys.length; j += 1) {
					const key = object_keys[j];
					if (key === '__proto__') {
						error(`Cannot stringify objects with __proto__ keys`, thing);
					}

					keys.push(key);
					walk(thing[key]);
					keys.pop();
				}
			}
		}
	}

	let name_index = 0;
	function next_name() {
		let name;
		do {
			name = get_name(name_index++);
		} while (reserved.has(name));
		return name;
	}

	// Wait until every custom source has been visited before assigning names.
	for (const thing of names.keys()) names.set(thing, next_name());
	if (primitive_counts) {
		for (const [thing, count] of primitive_counts) {
			if (count < 2) continue;
			const name = next_name();
			const length = stringify_cached_primitive(thing).length;
			// Include the declaration and IIFE overhead even if one already exists.
			if (length * count > length + (count + 1) * name.length + 40) names.set(thing, name);
		}
	}

	// Tracks declarations during serialization.
	const seen = new Set();
	const inlining = custom.size > 0 ? new Set() : null;

	/** @type {Map<any, () => void>} */
	const initializers = new Map();

	/** @type {string[]} */
	const statements = [];

	/**
	 * @param {any} thing
	 * @returns {string}
	 */
	function stringify(thing) {
		const name = names.get(thing);

		if (name) {
			if (!seen.has(thing)) {
				if (is_primitive(thing)) {
					seen.add(thing);
					statements.push(`let ${name}=${stringify_cached_primitive(thing)}`);
					return name;
				}
				const type = custom.has(thing) ? null : get_type(thing);

				switch (type) {
					case 'Object':
						seen.add(thing);
						statements.push(
							`let ${name}=${Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}'}`
						);
						Object.keys(thing).forEach((key) => {
							statements.push(`${name}${safe_prop(key)}=${stringify(thing[key])}`);
						});
						break;

					case 'Array': {
						seen.add(thing);
						const indices = valid_array_indices(thing);
						const array =
							thing.length > 32 + 2 * indices.length
								? stringify_sparse_array(thing.length)
								: `Array(${thing.length})`;
						statements.push(`let ${name}=${array}`);
						for (const i of indices) {
							statements.push(`${name}[${i}]=${stringify(thing[i])}`);
						}
						break;
					}

					case 'Set':
					case 'Map': {
						seen.add(thing);
						/** @type {string[]} */
						const entries = [];
						let initialized = false;
						let statement_index = -1;

						// Collect a ready prefix until a reference needs the collection.
						// Emit subsequent entries eagerly, preserving insertion order.
						const initialize = () => {
							if (initialized) return;
							initialized = true;
							initializers.delete(thing);
							statements.push(
								`let ${name}=new ${type}${entries.length ? `([${entries.join(',')}])` : ''}`
							);
						};

						initializers.set(thing, initialize);

						for (const entry of thing) {
							const args =
								type === 'Map' ? `${stringify(entry[0])},${stringify(entry[1])}` : stringify(entry);

							if (!initialized) {
								entries.push(type === 'Map' ? `[${args}]` : args);
							} else {
								const call = `.${type === 'Map' ? 'set' : 'add'}(${args})`;
								if (statement_index === statements.length - 1) {
									statements[statement_index] += call;
								} else {
									statement_index = statements.push(name + call) - 1;
								}
							}
						}

						initialize();
						break;
					}

					default:
						const str = actually_stringify(thing);
						if (!seen.has(thing)) statements.push(`let ${name}=${str}`);
						seen.add(thing);
				}
			} else {
				initializers.get(thing)?.();
			}

			return name;
		}

		if (is_primitive(thing)) {
			return stringify_cached_primitive(thing);
		}

		if (inlining === null) return actually_stringify(thing);

		// A singly referenced value can still be part of a custom constructor's
		// cycle. If inlining it re-enters itself, hoist it to break the cycle.
		if (inlining.has(thing)) {
			names.set(thing, next_name());
			return stringify(thing);
		}

		inlining.add(thing);
		const str = actually_stringify(thing);
		inlining.delete(thing);
		return names.get(thing) || str;
	}

	/**
	 * @param {any} thing
	 * @returns {string}
	 */
	function actually_stringify(thing) {
		const source = custom.get(thing);

		if (source) {
			return source.render(stringify);
		}

		const id = /** @type {number} */ (visited.get(thing));

		if (id >= 0) {
			// the fast pass serialized this, or started to
			const text = texts[id];
			if (text !== undefined && is_reusable(id, ends[id])) return text;

			const frame = partials?.get(thing);
			if (frame) return stringify_rest(frame);
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
						// This avoids paying per-hole, but has fixed overhead for
						// the allocator and wrapper, plus each index and colon.
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
						//       index + ":" + ","   — (d + 2) chars
						//     + "})"                — 2 chars
						//     = (18 + A) + P * (d + 2)
						//
						// where L is the array length, P is the number of
						// populated elements, A is the allocator length, and d
						// is the number of digits in L (an upper bound per index).
						//
						// Object.assign is cheaper when:
						//   (18 + A) + P * (d + 2) < L + 2
						const populated_keys = valid_array_indices(/** @type {any[]} */ (thing));
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
				return `new Set([${Array.from(thing, stringify).join(',')}])`;

			case 'Map': {
				const entries = Array.from(thing, ([k, v]) => `[${stringify(k)},${stringify(v)}]`);
				return `new Map([${entries.join(',')}])`;
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
				if (is_buffer(thing)) thing = new Uint8Array(thing);

				if (thing.buffer.byteLength % thing.BYTES_PER_ELEMENT !== 0) {
					return `new ${type}(${stringify(thing.buffer)},${thing.byteOffset},${thing.length})`;
				}

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

	/**
	 * Finish serializing a container that the fast pass started
	 * @param {{ thing: any, index: number, partial: string }} frame
	 */
	function stringify_rest({ thing, index, partial }) {
		let result = partial;

		if (Array.isArray(thing)) {
			for (let i = index; i < thing.length; i += 1) {
				if (i > index) result += ',';
				result += stringify(thing[i]);
			}

			return result + ']';
		}

		const object_keys = Object.keys(thing);

		for (let i = index; i < object_keys.length; i += 1) {
			const key = object_keys[i];
			if (i > index) result += `,${safe_key(key)}:`;
			result += stringify(thing[key]);
		}

		return result + '}';
	}

	// The text the fast pass produced for an object can be reused unless something
	// inside it has since been given a name, in which case the name belongs there
	// instead. Ids were handed out in the order things were visited, so the things
	// inside an object are the ones with ids between its own and its `end`.
	const { texts, ends, count } = plain;

	/**
	 * `named[id]` is the number of named things with an id less than `id`
	 * @type {Uint32Array | null}
	 */
	let named = null;

	if (names.size > 0 && count > 0) {
		named = new Uint32Array(count + 1);

		for (const thing of names.keys()) {
			const id = visited.get(thing);
			if (id !== undefined && id >= 0) named[id + 1] = 1;
		}

		for (let i = 1; i <= count; i += 1) named[i] += named[i - 1];
	}

	/**
	 * Whether nothing with an id from `start` up to (but not including) `end` has a name
	 * @param {number} start
	 * @param {number} end
	 */
	function is_reusable(start, end) {
		return named === null || named[end] === named[start];
	}

	/** @type {Map<any, { thing: any, index: number, partial: string }> | null} */
	let partials = null;

	for (const frame of frames) {
		const { thing, partial } = frame;
		if (partial === undefined) continue;
		// the fast pass visited everything in `partial` after `thing` and before it stopped
		if (!is_reusable(/** @type {number} */ (visited.get(thing)), count)) continue;
		// sparse arrays are serialized differently
		if (Array.isArray(thing) && valid_array_indices(thing).length !== thing.length) continue;
		(partials ??= new Map()).set(thing, /** @type {any} */ (frame));
	}

	const str = stringify(value);

	if (statements.length === 0) {
		return str;
	}

	return `(function(){${statements.join(';')};return ${str}}())`;
}

/**
 * Single-pass serializer for acyclic trees of plain objects, dense arrays, dates,
 * strings, numbers, booleans, `null` and `undefined`. Its output is identical to
 * that of the general algorithm. `serialize` returns `null` as soon as it meets
 * anything else — a repeated reference, a repeated long string, a value the
 * replacer claims, any other kind of object — leaving behind what the general
 * algorithm needs to carry on from that point.
 */
// Text is flattened once this much of it has accumulated. See `#flatten`
const CHUNK_LENGTH = 4096;

class PlainSerializer {
	/**
	 * Every object the replacer has been called with, and what it returned. The
	 * general algorithm reads from this rather than calling the replacer a second time
	 * @type {Map<any, any>}
	 */
	replaced = new Map();

	/**
	 * Every object and long string visited so far, numbered in the order they were visited
	 * @type {Map<any, number>}
	 */
	ids = new Map();

	/** The number of ids handed out */
	count = 0;

	/**
	 * The serialization of each array and plain object that was visited in full, by id
	 * @type {string[]}
	 */
	texts = [];

	/**
	 * For each of those, the value `count` had once its contents had been visited
	 * @type {number[]}
	 */
	ends = [];

	/**
	 * Every long string visited so far
	 * @type {string[]}
	 */
	long_strings = [];

	/**
	 * If the pass stopped, the arrays and objects it was inside at the time, innermost
	 * first. `index` is the position (in the array, or in `Object.keys`) of the child
	 * being visited, and `key` is that child's key. `partial`, if present, is the
	 * container's serialization up to that child
	 * @type {Array<{ thing: any, index: number, key: string | number, partial?: string }>}
	 */
	frames = [];

	/**
	 * `key:` for each key seen so far, as it is written at the start of an object
	 * @type {Map<string, string>}
	 */
	#first_keys = new Map();

	/**
	 * `,key:` for each key seen so far, as it is written anywhere else
	 * @type {Map<string, string>}
	 */
	#keys = new Map();

	#replacer;

	#ok = true;

	#read = 0;

	/** @param {UnevalReplacer | undefined} replacer */
	constructor(replacer) {
		this.#replacer = replacer;
	}

	/**
	 * @param {any} value
	 * @returns {string | null}
	 */
	serialize(value) {
		const result = this.#serialize(value);
		return this.#ok ? result : null;
	}

	/**
	 * @param {any} thing
	 * @returns {string}
	 */
	#serialize(thing) {
		const ids = this.ids;

		switch (typeof thing) {
			case 'string':
				if (thing.length >= MIN_STRING_LENGTH) {
					// a long string that appears more than once may need to be hoisted
					if (ids.has(thing)) return this.#bail();
					ids.set(thing, this.count++);
					this.long_strings.push(thing);
				}

				return stringify_string(thing);

			case 'number':
			case 'boolean':
			case 'undefined':
				return stringify_primitive(thing);

			case 'object':
				break;

			default:
				return this.#bail();
		}

		if (thing === null) return 'null';

		if (ids.has(thing)) return this.#bail();
		const id = this.count++;
		ids.set(thing, id);

		if (this.#replacer) {
			const fragment = this.#replacer(thing, js);
			this.replaced.set(thing, fragment);

			if (fragment !== undefined && fragment !== null && fragment !== false) {
				return this.#bail_at(thing);
			}
		}

		const proto = Object.getPrototypeOf(thing);

		if (proto === Array.prototype) {
			let result = '[';
			// text that has yet to be flattened and added to `result`
			let chunk = '';

			for (let i = 0; i < thing.length; i += 1) {
				const element = thing[i];
				// holes are serialized differently to `undefined`
				if (element === undefined && !(i in thing)) {
					this.frames.push({ thing, index: i, key: i });
					return this.#bail();
				}

				if (i > 0) chunk += ',';
				const text = this.#serialize(element);

				if (!this.#ok) {
					this.frames.push({ thing, index: i, key: i, partial: result + chunk });
					return '';
				}

				if (text.length >= CHUNK_LENGTH) {
					// already in chunks of its own
					result += chunk;
					result += text;
					chunk = '';
				} else {
					chunk += text;

					if (chunk.length >= CHUNK_LENGTH) {
						result += this.#flatten(chunk);
						chunk = '';
					}
				}
			}

			this.ends[id] = this.count;
			return (this.texts[id] = result + chunk + ']');
		}

		if (proto === Date.prototype) {
			// `Object.create(Date.prototype)` is not a date
			if (Object.prototype.toString.call(thing) !== '[object Date]') return this.#bail_at(thing);
			return `new Date(${thing.getTime()})`;
		}

		if (proto !== Object.prototype || Object.getOwnPropertySymbols(thing).length > 0) {
			return this.#bail_at(thing);
		}

		const keys = Object.keys(thing);
		let result = '{';
		let chunk = '';

		for (let i = 0; i < keys.length; i += 1) {
			const key = keys[i];

			if (key === '__proto__') {
				this.frames.push({ thing, index: i, key });
				return this.#bail();
			}

			const prefixes = i > 0 ? this.#keys : this.#first_keys;
			let prefix = prefixes.get(key);

			if (prefix === undefined) {
				prefixes.set(key, (prefix = `${i > 0 ? ',' : ''}${safe_key(key)}:`));
			}

			chunk += prefix;
			const text = this.#serialize(thing[key]);

			if (!this.#ok) {
				this.frames.push({ thing, index: i, key, partial: result + chunk });
				return '';
			}

			if (text.length >= CHUNK_LENGTH) {
				result += chunk;
				result += text;
				chunk = '';
			} else {
				chunk += text;

				if (chunk.length >= CHUNK_LENGTH) {
					result += this.#flatten(chunk);
					chunk = '';
				}
			}
		}

		this.ends[id] = this.count;
		return (this.texts[id] = result + chunk + '}');
	}

	/**
	 * Appending to a string doesn't copy it: engines record that the result is one
	 * string followed by another, so text built from many small pieces is a deep
	 * tree of fragments, every one of which stays alive (and gets moved around by
	 * the garbage collector) until something reads the text. Reading a character
	 * makes the engine copy the pieces into a single string and drop the tree.
	 * @param {string} text
	 */
	#flatten(text) {
		// accumulated so that the read can't be optimized away
		this.#read += text.charCodeAt(0);
		return text;
	}

	/**
	 * Stop at an object that the general algorithm needs to visit from scratch
	 * @param {any} thing
	 */
	#bail_at(thing) {
		this.ids.delete(thing);
		return this.#bail();
	}

	#bail() {
		this.#ok = false;
		return '';
	}
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
	const array = new /** @type {any} */ (globalThis)[type](buffer);

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
	if (type === 'number') {
		// only numbers between -1 and 1 have a leading zero to remove
		if (thing > 0 && thing < 1) return str.charCodeAt(0) === 48 ? str.slice(1) : str;
		if (thing < 0 && thing > -1) return str.charCodeAt(1) === 48 ? `-${str.slice(2)}` : str;
		return str;
	}
	if (type === 'bigint') return thing + 'n';
	return str;
}
