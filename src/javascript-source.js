const SOURCE = Symbol('JavaScriptSource');

/**
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {JavaScriptSource}
 */
export function js(strings, ...values) {
	if (!Array.isArray(strings) || !('raw' in strings) || !Array.isArray(strings.raw)) {
		throw new TypeError('`js` must be used as a tagged template, but was called as a regular function');
	}
	return create_source(strings, values);
}

/**
 * @param {readonly string[]} strings
 * @param {readonly unknown[]} values
 * @returns {JavaScriptSource}
 */
export function create_source(strings, values) {
	return { [SOURCE]: { strings, values } };
}

/**
 * @param {unknown} value
 * @returns {value is JavaScriptSource}
 */
export function is_source(value) {
	return typeof value === 'object' && value !== null && SOURCE in value;
}

/**
 * @param {string} text
 * @returns {JavaScriptSource}
 */
export function raw_source(text) {
	return create_source([text], []);
}

/**
 * @param {JavaScriptSource} source
 * @param {(value: unknown) => string} render
 */
export function render_source(source, render) {
	const { strings, values } = source[SOURCE];
	let result = strings[0];
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		result += is_source(value) ? render_source(value, render) : render(value);
		result += strings[i + 1];
	}
	return result;
}

/**
 * @param {JavaScriptSource} source
 * @param {(value: unknown) => void} visit
 * @param {Set<string>} reserved
 * @param {Set<readonly string[]>} templates
 */
export function visit_source(source, visit, reserved, templates) {
	const { strings, values } = source[SOURCE];
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
		if (is_source(value)) visit_source(value, visit, reserved, templates);
		else visit(value);
	}
}

/**
 * The result of the `js` tag passed to an `uneval` replacer.
 * @typedef {{ readonly [SOURCE]: { readonly strings: readonly string[], readonly values: readonly unknown[] } }} JavaScriptSource
 */
