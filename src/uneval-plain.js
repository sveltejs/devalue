/**
 * @import { UnevalReplacer } from './types.js';
 */
import { js } from './javascript-source.js';
import { MIN_STRING_LENGTH, safe_key, stringify_primitive, stringify_string } from './utils.js';

/**
 * Single-pass serializer for acyclic trees of plain objects, dense arrays, dates,
 * strings, numbers, booleans, `null` and `undefined`. Its output is identical to
 * that of the general algorithm. `serialize` returns `null` as soon as it meets
 * anything else — a repeated reference, a repeated long string, a value the
 * replacer claims, any other kind of object — leaving behind what the general
 * algorithm needs to carry on from that point.
 */
export class PlainSerializer {
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

			for (let i = 0; i < thing.length; i += 1) {
				const element = thing[i];
				// holes are serialized differently to `undefined`
				if (element === undefined && !(i in thing)) {
					this.frames.push({ thing, index: i, key: i });
					return this.#bail();
				}

				if (i > 0) result += ',';
				result += this.#serialize(element);

				if (!this.#ok) {
					this.frames.push({ thing, index: i, key: i, partial: result });
					return '';
				}
			}

			this.ends[id] = this.count;
			return (this.texts[id] = result + ']');
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

			result += prefix;
			result += this.#serialize(thing[key]);

			if (!this.#ok) {
				this.frames.push({ thing, index: i, key, partial: result });
				return '';
			}
		}

		this.ends[id] = this.count;
		return (this.texts[id] = result + '}');
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
