const SOURCE = Symbol('JavaScriptSource');
const IDENTIFIER = Symbol('JavaScriptIdentifier');

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

/** Creates a reusable generated identifier for interpolation into trusted source. */
js.identifier = function identifier() {
	return { [SOURCE]: { strings: [''], values: [] }, [IDENTIFIER]: true };
};

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

/** @param {JavaScriptSource} source */
export function is_identifier(source) {
	return IDENTIFIER in source;
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
 * @param {(identifier: JavaScriptSource) => string} render_identifier
 */
export function render_source(source, render, render_identifier) {
	if (is_identifier(source)) return render_identifier(source);
	const { strings, values } = source[SOURCE];
	let result = strings[0];
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		result += is_source(value) ? render_source(value, render, render_identifier) : render(value);
		result += strings[i + 1];
	}
	return result;
}

/**
 * @param {JavaScriptSource} source
 * @param {(value: unknown) => void} visit
 * @param {Set<string>} reserved
 */
export function visit_source(source, visit, reserved) {
	if (is_identifier(source)) return;
	const { strings, values } = source[SOURCE];
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
	for (const value of values) {
		if (is_source(value)) visit_source(value, visit, reserved);
		else visit(value);
	}
}

/**
 * The result of the `js` tag passed to an `uneval` replacer.
 * @typedef {{ readonly [SOURCE]: { readonly strings: readonly string[], readonly values: readonly unknown[] } }} JavaScriptSource
 */
