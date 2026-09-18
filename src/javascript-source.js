const SOURCE = Symbol('JavaScriptSource');

export class JavaScriptSource {
	/**
	 * @param {TemplateStringsArray} strings
	 * @param {unknown[]} values
	 */
	constructor(strings, values) {
		this.strings = strings;
		this.values = values;
	}

	/**
	 * @param {(value: unknown) => string} fn
	 */
	render(fn) {
		const { strings, values } = this;
		let result = strings[0];
		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			result += JavaScriptSource.is_fragment(value)
				? JavaScriptSource.from(value).render(fn)
				: fn(value);
			result += strings[i + 1];
		}
		return result;
	}

	/**
	 * @param {(value: unknown) => void} fn
	 * @param {Set<string>} reserved
	 * @param {Set<readonly string[]>} templates
	 */
	visit(fn, reserved, templates) {
		const { strings, values } = this;
		// Each template site reuses its string array, but its interpolations can change.
		if (!templates.has(strings)) {
			templates.add(strings);
			for (const string of strings) {
				// Generated names are ASCII, but literal identifiers can use Unicode escapes.
				const decoded = string.replace(
					/\\u(?:([\da-f]{4})|\{([\da-f]+)\})/gi,
					(escape, hex, code_point) => {
						const code = parseInt(hex || code_point, 16);
						return code < 128 ? String.fromCharCode(code) : escape;
					}
				);
				// Conservatively reserve words even in property names, strings and comments.
				for (const name of decoded.match(/[a-zA-Z_$][\w$]*/g) || []) reserved.add(name);
			}
		}
		for (const value of values) {
			if (JavaScriptSource.is_fragment(value)) {
				JavaScriptSource.from(value).visit(fn, reserved, templates);
			} else {
				fn(value);
			}
		}
	}

	/**
	 * @param {unknown} value
	 * @returns {value is JavaScriptFragment}
	 */
	static is_fragment(value) {
		return typeof value === 'object' && value !== null && SOURCE in value;
	}

	/**
	 * @param {JavaScriptFragment} fragment
	 * @returns {JavaScriptSource}
	 */
	static from(fragment) {
		if (!JavaScriptSource.is_fragment(fragment)) {
			throw new TypeError('Invalid JavaScript fragment');
		}
		return fragment[SOURCE];
	}
}

/**
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {JavaScriptFragment}
 */
export function js(strings, ...values) {
	if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
		throw new TypeError(
			'`js` must be used as a tagged template, but was called as a regular function'
		);
	}
	return { [SOURCE]: new JavaScriptSource(strings, values) };
}

/**
 * The opaque result of the `js` tag passed to an `uneval` replacer.
 * @typedef {{ readonly [SOURCE]: JavaScriptSource }} JavaScriptFragment
 */
