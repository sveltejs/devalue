import { describe, expect, test } from 'vitest';
import { parse, stringify, stringifyAsync } from '../index.js';

describe.each([
	{ name: 'stringify', fn: stringify },
	{ name: 'stringifyAsync', fn: stringifyAsync }
])('$name property names', ({ fn }) => {
	test('escapes property names, also when served from the key cache', async () => {
		const object = { plain: 1, 'quote"': 2, 'angle<': 3, 'newline\n': 4 };
		const expected = '[{"plain":1,"quote\\"":2,"angle\\u003C":3,"newline\\n":4},1,2,3,4]';

		expect(await fn(object)).toBe(expected);
		expect(await fn(object)).toBe(expected);
		expect(await fn(Object.assign(Object.create(null), object))).toBe(
			'[["null","plain",1,"quote\\"",2,"angle\\u003C",3,"newline\\n",4],1,2,3,4]'
		);
	});

	test('quotes property names too long for the key cache', async () => {
		const long = 'k'.repeat(65);
		const object = { [long]: 1, [long + '"']: 2 };
		const expected = `[{"${long}":1,"${long}\\"":2},1,2]`;

		expect(await fn(object)).toBe(expected);
		expect(await fn(object)).toBe(expected);
		expect(parse(expected)).toEqual(object);
	});

	test('quotes more distinct property names than the key cache holds', async () => {
		const object = {};
		for (let i = 0; i < 1500; i += 1) {
			object[`key-${i}`] = i;
			object[`quote"${i}`] = i;
		}

		expect(parse(await fn(object))).toEqual(object);
		expect(parse(await fn(object))).toEqual(object);
	});
});
