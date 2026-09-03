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
	return { [SOURCE]: true, strings, values };
}

/**
 * @param {unknown} value
 * @returns {value is JavaScriptSource}
 */
export function is_source(value) {
	return typeof value === 'object' && value !== null && /** @type {JavaScriptSource} */ (value)[SOURCE] === true;
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
	let result = source.strings[0];
	for (let i = 0; i < source.values.length; i++) {
		const value = source.values[i];
		result += is_source(value) ? render_source(value, render) : render(value);
		result += source.strings[i + 1];
	}
	return result;
}

/**
 * @param {JavaScriptSource} source
 * @param {(value: unknown) => void} visit
 */
export function visit_source(source, visit) {
	for (const value of source.values) {
		if (is_source(value)) visit_source(value, visit);
		else visit(value);
	}
}

/**
 * @typedef {{ readonly [SOURCE]: true, readonly strings: readonly string[], readonly values: readonly unknown[] }} JavaScriptSource
 */
