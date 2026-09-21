import assert from 'node:assert/strict';
import * as vm from 'vm';
import { describe, test, expect } from 'vitest';
import * as consts from '../src/constants.js';
import { uneval, unflatten, parse, stringify, stringifyAsync } from '../index.js';

globalThis.Temporal ??= (await import('@js-temporal/polyfill')).Temporal;

class Foo {
	constructor(value) {
		this.value = value;
	}
}

class Bar {
	constructor(value) {
		this.value = value;
	}
}

function NullObject() {}
NullObject.prototype = Object.create(null);

const fixtures = {
	primitives: [
		{
			name: 'number: positive integer',
			value: 42,
			js: '42',
			json: '[42]'
		},
		{
			name: 'number: negative integer',
			value: -5,
			js: '-5',
			json: '[-5]'
		},
		{
			name: 'number: positive decimal',
			value: 0.1,
			js: '.1',
			json: '[0.1]'
		},
		{
			name: 'number: negative decimal',
			value: -0.1,
			js: '-.1',
			json: '[-0.1]'
		},
		{
			name: 'number: NaN',
			value: NaN,
			js: 'NaN',
			json: `${consts.NAN}`,
			validate: (value) => expect(Number.isNaN(value)).toBeTruthy()
		},
		{
			name: 'number: +Infinity',
			value: Infinity,
			js: 'Infinity',
			json: `${consts.POSITIVE_INFINITY}`
		},
		{
			name: 'number: -Infinity',
			value: -Infinity,
			js: '-Infinity',
			json: `${consts.NEGATIVE_INFINITY}`
		},
		{
			name: 'number: zero',
			value: 0,
			js: '0',
			json: '[0]'
		},
		{
			name: 'number: negative zero',
			value: -0,
			js: '-0',
			json: `${consts.NEGATIVE_ZERO}`,
			validate(value) {
				expect(Object.is(value, -0)).toBeTruthy();
			}
		},
		{
			name: 'string',
			value: 'woo!!!',
			js: '"woo!!!"',
			json: '["woo!!!"]'
		},
		{
			name: 'boolean',
			value: true,
			js: 'true',
			json: '[true]'
		},
		{
			name: 'bigint',
			value: 1n,
			js: '1n',
			json: '[["BigInt","1"]]'
		},
		{
			name: 'undefined',
			value: undefined,
			js: 'void 0',
			json: `${consts.UNDEFINED}`
		},
		{
			name: 'null',
			value: null,
			js: 'null',
			json: '[null]'
		}
		// symbols are not supported; see further tests
	],

	boxed_primitives: [
		{
			name: 'Number: positive integer',
			value: new Number(42),
			js: 'Object(42)',
			json: '[["Object",1],42]'
		},
		{
			name: 'Number: negative integer',
			value: new Number(-2),
			js: 'Object(-2)',
			json: '[["Object",1],-2]'
		},
		{
			name: 'Number: positive decimal',
			value: new Number(0.1),
			js: 'Object(.1)',
			json: '[["Object",1],0.1]'
		},
		{
			name: 'Number: negative decimal',
			value: new Number(-0.1),
			js: 'Object(-.1)',
			json: '[["Object",1],-0.1]'
		},
		{
			name: 'Number: NaN',
			value: new Number(NaN),
			js: 'Object(NaN)',
			json: `[["Object",${consts.NAN}]]`,
			validate: (value) => {
				expect(value instanceof Number).toBeTruthy();
				expect(Number.isNaN(value.valueOf())).toBeTruthy();
			}
		},
		{
			name: 'Number: +Infinity',
			value: new Number(Infinity),
			js: 'Object(Infinity)',
			json: `[["Object",${consts.POSITIVE_INFINITY}]]`
		},
		{
			name: 'Number: -Infinity',
			value: new Number(-Infinity),
			js: 'Object(-Infinity)',
			json: `[["Object",${consts.NEGATIVE_INFINITY}]]`
		},
		{
			name: 'Number: zero',
			value: new Number(0),
			js: 'Object(0)',
			json: '[["Object",1],0]'
		},
		{
			name: 'Number: negative zero',
			value: new Number(-0),
			js: 'Object(-0)',
			json: `[["Object",${consts.NEGATIVE_ZERO}]]`,
			validate(value) {
				expect(typeof value).toBe('object');
				expect(Object.is(value.valueOf(), -0)).toBeTruthy();
			}
		},
		{
			name: 'String',
			value: new String('woo!!!'),
			js: 'Object("woo!!!")',
			json: '[["Object",1],"woo!!!"]'
		},
		{
			name: 'Boolean',
			value: new Boolean(true),
			js: 'Object(true)',
			json: '[["Object",1],true]'
		},
		{
			name: 'BigInt',
			value: Object(1n),
			js: 'Object(1n)',
			json: '[["Object",1],["BigInt","1"]]'
		}
		// it's not possible to box undefined or null
		// boxed symbols are not supported; see further tests
	],

	basics: [
		{
			name: 'RegExp',
			value: /regexp/gim,
			js: 'new RegExp("regexp","gim")',
			json: '[["RegExp","regexp","gim"]]'
		},
		{
			name: 'Date',
			value: new Date(1e12),
			js: 'new Date(1000000000000)',
			json: '[["Date","2001-09-09T01:46:40.000Z"]]'
		},
		{
			name: 'invalid Date',
			value: new Date(''),
			js: 'new Date(NaN)',
			json: '[["Date",""]]',
			validate: (value) => {
				expect(isNaN(value.valueOf())).toBeTruthy();
			}
		},
		{
			name: 'Array',
			value: ['a', 'b', 'c'],
			js: '["a","b","c"]',
			json: '[[1,2,3],"a","b","c"]'
		},
		{
			name: 'Array where negative zero appears after normal zero',
			value: [0, -0],
			js: '[0,-0]',
			json: `[[1,${consts.NEGATIVE_ZERO}],0]`,
			validate: (value) => {
				expect(Object.is(value[0], 0)).toBeTruthy();
				expect(Object.is(value[1], -0)).toBeTruthy();
			}
		},
		{
			name: 'Array (empty)',
			value: [],
			js: '[]',
			json: '[[]]'
		},
		{
			name: 'Array (sparse)',
			value: [, 'b', ,],
			js: '[,"b",,]',
			json: `[[${consts.HOLE},1,${consts.HOLE}],"b"]`,
			validate: (value) => {
				expect(value.length).toBe(3);
				expect(Object.keys(value)).toEqual(['1']);
				expect(value[1]).toBe('b');
			}
		},
		((arr) => {
			arr[1000000] = 'x';
			return {
				name: 'Array (very sparse)',
				value: arr,
				js: `Object.assign((function(a){a[4294967294]=0;delete a[4294967294];a.length=1000001;return a}([])),{1000000:"x"})`,
				json: `[[${consts.SPARSE},1000001,1000000,1],"x"]`,
				validate: (value) => {
					expect(value.length).toBe(1000001);
					expect(value[1000000]).toBe('x');
					expect(!(0 in value)).toBeTruthy();
					expect(!(999999 in value)).toBeTruthy();
				}
			};
		})([]),
		((arr) => {
			arr[10] = 'a';
			arr[20] = 'b';
			return {
				name: 'Array (very sparse, multiple values)',
				value: arr,
				js: `[,,,,,,,,,,"a",,,,,,,,,,"b"]`,
				json: `[[${consts.SPARSE},21,10,1,20,2],"a","b"]`,
				validate: (value) => {
					expect(value.length).toBe(21);
					expect(value[10]).toBe('a');
					expect(value[20]).toBe('b');
					expect(!(0 in value)).toBeTruthy();
					expect(!(9 in value)).toBeTruthy();
					expect(!(11 in value)).toBeTruthy();
				}
			};
		})([]),
		{
			name: 'Object',
			value: { foo: 'bar', 'x-y': 'z' },
			js: '{foo:"bar","x-y":"z"}',
			json: '[{"foo":1,"x-y":2},"bar","z"]'
		},
		{
			name: 'Set',
			value: new Set([1, 2, 3]),
			js: 'new Set([1,2,3])',
			json: '[["Set",1,2,3],1,2,3]',
			validate: (value) => expect([...value]).toEqual([1, 2, 3])
		},
		{
			name: 'Map',
			value: new Map([['a', 'b']]),
			js: 'new Map([["a","b"]])',
			json: '[["Map",1,2],"a","b"]',
			validate: (value) => expect([...value]).toEqual([['a', 'b']])
		},
		{
			name: 'Uint8Array',
			value: new Uint8Array([1, 2, 3]),
			js: 'new Uint8Array([1,2,3])',
			json: '[["Uint8Array",1],["ArrayBuffer","AQID"]]'
		},
		{
			// `Buffer.alloc` does not allocate from Node's shared pool, so the buffer
			// backing this view is exactly four bytes and the expectations are stable
			name: 'Node Buffer',
			value: Buffer.alloc(4, 65),
			js: 'new Uint8Array([65,65,65,65])',
			json: '[["Uint8Array",1],["ArrayBuffer","QUFBQQ=="]]',
			validate: (value) => expect(value).toEqual(new Uint8Array([65, 65, 65, 65]))
		},
		{
			name: 'Float64Array with negative zero',
			value: new Float64Array([-0, 1.5]),
			js: 'new Float64Array([-0,1.5])',
			json: '[["Float64Array",1],["ArrayBuffer","AAAAAAAAAIAAAAAAAAD4Pw=="]]',
			validate: (value) => {
				expect(Object.is(value[0], -0)).toBeTruthy();
				expect(value[1]).toEqual(1.5);
			}
		},
		{
			name: 'BigInt64Array',
			value: new BigInt64Array([1n, -2n, 3n]),
			js: 'new BigInt64Array([1n,-2n,3n])',
			json: '[["BigInt64Array",1],["ArrayBuffer","AQAAAAAAAAD+/////////wMAAAAAAAAA"]]'
		},
		{
			name: 'BigUint64Array',
			value: new BigUint64Array([1n, 2n, 3n]),
			js: 'new BigUint64Array([1n,2n,3n])',
			json: '[["BigUint64Array",1],["ArrayBuffer","AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAA"]]'
		},
		{
			name: 'ArrayBuffer',
			value: new Uint8Array([1, 2, 3]).buffer,
			js: 'new Uint8Array([1,2,3]).buffer',
			json: '[["ArrayBuffer","AQID"]]'
		},
		{
			name: 'DataView',
			value: new DataView(new Uint8Array([1, 2, 3]).buffer),
			js: 'new DataView(new Uint8Array([1,2,3]).buffer)',
			json: '[["DataView",1],["ArrayBuffer","AQID"]]'
		},
		{
			name: 'DataView subview',
			value: new DataView(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer, 2, 4),
			js: 'new DataView(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer,2,4)',
			json: '[["DataView",1,2,4],["ArrayBuffer","AAECAwQFBgcICQ=="]]',
			validate: (value) => {
				expect(value.byteOffset).toBe(2);
				expect(value.byteLength).toBe(4);
				expect([...new Uint8Array(value.buffer)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}
		},
		{
			name: 'URL',
			value: new URL('https://user:password@example.com/<script>/path?foo=bar#hash'),
			js: 'new URL("https://user:password@example.com/%3Cscript%3E/path?foo=bar#hash")',
			json: '[["URL","https://user:password@example.com/%3Cscript%3E/path?foo=bar#hash"]]'
		},
		{
			name: 'URLSearchParams',
			value: new URLSearchParams('foo=1&foo=2&baz=<+>'),
			js: 'new URLSearchParams("foo=1&foo=2&baz=%3C+%3E")',
			json: '[["URLSearchParams","foo=1&foo=2&baz=%3C+%3E"]]'
		},
		{
			name: 'Sliced typed array',
			value: new Uint16Array([10, 20, 30, 40]).subarray(1, 3),
			js: 'new Uint16Array([10,20,30,40]).subarray(1,3)',
			json: '[["Uint16Array",1,2,2],["ArrayBuffer","CgAUAB4AKAA="]]',
			validate: (value) => {
				expect(value.byteOffset).toBe(2);
				expect(value.length).toBe(2);
				expect([...new Uint16Array(value.buffer)]).toEqual([10, 20, 30, 40]);
			}
		},
		{
			name: 'Temporal.Duration',
			value: Temporal.Duration.from({ years: 1, months: 2, days: 3 }),
			js: 'Temporal.Duration.from("P1Y2M3D")',
			json: '[["Temporal.Duration","P1Y2M3D"]]'
		},
		{
			name: 'Temporal.Instant',
			value: Temporal.Instant.from('1999-09-29T05:30:00Z'),
			js: 'Temporal.Instant.from("1999-09-29T05:30:00Z")',
			json: '[["Temporal.Instant","1999-09-29T05:30:00Z"]]'
		},
		{
			name: 'Temporal.PlainDate',
			value: Temporal.PlainDate.from({ year: 1999, month: 9, day: 29 }),
			js: 'Temporal.PlainDate.from("1999-09-29")',
			json: '[["Temporal.PlainDate","1999-09-29"]]'
		},
		{
			name: 'Temporal.PlainTime',
			value: Temporal.PlainTime.from({ hour: 12, minute: 34, second: 56 }),
			js: 'Temporal.PlainTime.from("12:34:56")',
			json: '[["Temporal.PlainTime","12:34:56"]]'
		},
		{
			name: 'Temporal.PlainDateTime',
			value: Temporal.PlainDateTime.from({
				year: 1999,
				month: 9,
				day: 29,
				hour: 12,
				minute: 34,
				second: 56
			}),
			js: 'Temporal.PlainDateTime.from("1999-09-29T12:34:56")',
			json: '[["Temporal.PlainDateTime","1999-09-29T12:34:56"]]'
		},
		{
			name: 'Temporal.PlainMonthDay',
			value: Temporal.PlainMonthDay.from({ month: 9, day: 29 }),
			js: 'Temporal.PlainMonthDay.from("09-29")',
			json: '[["Temporal.PlainMonthDay","09-29"]]'
		},
		{
			name: 'Temporal.PlainYearMonth',
			value: Temporal.PlainYearMonth.from({ year: 1999, month: 9 }),
			js: 'Temporal.PlainYearMonth.from("1999-09")',
			json: '[["Temporal.PlainYearMonth","1999-09"]]'
		},
		{
			name: 'Temporal.ZonedDateTime',
			value: Temporal.ZonedDateTime.from({
				year: 1999,
				month: 9,
				day: 29,
				hour: 12,
				minute: 34,
				second: 56,
				timeZone: 'Europe/Rome'
			}),
			js: 'Temporal.ZonedDateTime.from("1999-09-29T12:34:56+02:00[Europe/Rome]")',
			json: '[["Temporal.ZonedDateTime","1999-09-29T12:34:56+02:00[Europe/Rome]"]]'
		}
	],

	strings: [
		{
			name: 'newline',
			value: 'a\nb',
			js: JSON.stringify('a\nb'),
			json: '["a\\nb"]'
		},
		{
			name: 'double quotes',
			value: '"yar"',
			js: JSON.stringify('"yar"'),
			json: '["\\"yar\\""]'
		},
		{
			name: 'lone low surrogate',
			value: 'a\uDC00b',
			js: '"a\\udc00b"',
			json: '["a\\udc00b"]'
		},
		{
			name: 'lone high surrogate',
			value: 'a\uD800b',
			js: '"a\\ud800b"',
			json: '["a\\ud800b"]'
		},
		{
			name: 'two low surrogates',
			value: 'a\uDC00\uDC00b',
			js: '"a\\udc00\\udc00b"',
			json: '["a\\udc00\\udc00b"]'
		},
		{
			name: 'two high surrogates',
			value: 'a\uD800\uD800b',
			js: '"a\\ud800\\ud800b"',
			json: '["a\\ud800\\ud800b"]'
		},
		{
			name: 'surrogate pair',
			value: '𝌆',
			js: JSON.stringify('𝌆'),
			json: `[${JSON.stringify('𝌆')}]`
		},
		{
			name: 'surrogate pair in wrong order',
			value: 'a\uDC00\uD800b',
			js: '"a\\udc00\\ud800b"',
			json: '["a\\udc00\\ud800b"]'
		},
		{
			name: 'nul',
			value: '\0',
			js: '"\\u0000"',
			json: '["\\u0000"]'
		},
		{
			name: 'control character',
			value: '\u0001',
			js: '"\\u0001"',
			json: '["\\u0001"]'
		},
		{
			name: 'control character extremum',
			value: '\u001F',
			js: '"\\u001f"',
			json: '["\\u001f"]'
		},
		{
			name: 'backslash',
			value: '\\',
			js: JSON.stringify('\\'),
			json: '["\\\\"]'
		}
	],

	cycles: [
		((map) => {
			map.set('self', map);
			return {
				name: 'Map (cyclical)',
				value: map,
				js: '(function(){let a=new Map;a.set("self",a);return a}())',
				json: '[["Map",1,0],"self"]',
				validate: (value) => {
					expect(value.get('self')).toBe(value);
				}
			};
		})(new Map()),

		((set) => {
			set.add(set);
			set.add(42);
			return {
				name: 'Set (cyclical)',
				value: set,
				js: '(function(){let a=new Set;a.add(a).add(42);return a}())',
				json: '[["Set",0,1],42]',
				validate: (value) => {
					expect(value.size).toBe(2);
					expect(value.has(42)).toBeTruthy();
					expect(value.has(value)).toBeTruthy();
				}
			};
		})(new Set()),

		((arr) => {
			arr[0] = arr;
			return {
				name: 'Array (cyclical)',
				value: arr,
				js: '(function(){let a=Array(1);a[0]=a;return a}())',
				json: '[[0]]',
				validate: (value) => {
					expect(value.length).toBe(1);
					expect(value[0]).toBe(value);
				}
			};
		})([]),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object (cyclical)',
				value: obj,
				js: '(function(){let a={};a.self=a;return a}())',
				json: '[{"self":0}]',
				validate: (value) => {
					expect(value.self).toBe(value);
				}
			};
		})({}),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype (cyclical)',
				value: obj,
				js: '(function(){let a=Object.create(null);a.self=a;return a}())',
				json: '[["null","self",0]]',
				validate: (value) => {
					expect(Object.getPrototypeOf(value)).toBe(null);
					expect(value.self).toBe(value);
				}
			};
		})(Object.create(null)),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype class',
				value: obj,
				js: '(function(){let a={};a.foo="bar";a.self=a;return a}())',
				json: '[{"foo":1,"self":0},"bar"]',
				validate: (value) => {
					expect(value.foo).toBe('bar');
					expect(value.self).toBe(value);
				}
			};
		})(Object.assign(new NullObject(), { foo: 'bar' })),

		((first, second) => {
			first.second = second;
			second.first = first;
			return {
				name: 'Object (cyclical)',
				value: [first, second],
				js: '(function(){let a={},b={};a.first=b;b.second=a;return [b,a]}())',
				json: '[[1,2],{"second":2},{"first":1}]',
				validate: (value) => {
					expect(value[0].second).toBe(value[1]);
					expect(value[1].first).toBe(value[0]);
				}
			};
		})({}, {})
	],

	repetition: [
		{
			name: 'string (repetition)',
			value: ['a string', 'a string'],
			js: '["a string","a string"]',
			json: '[[1,1],"a string"]'
		},

		{
			name: 'null (repetition)',
			value: [null, null],
			js: '[null,null]',
			json: '[[1,1],null]'
		},

		{
			name: 'number: NaN (repetition)',
			value: [NaN, NaN],
			js: '[NaN,NaN]',
			json: `[[${consts.NAN},${consts.NAN}]]`
		},

		{
			name: 'Number (repetition)',
			value: ((number) => [number, number])(Object(42)),
			js: '(function(){let a=Object(42);return [a,a]}())',
			json: '[[1,1],["Object",2],42]',
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'BigInt (repetition)',
			value: ((bigint) => [bigint, bigint])(Object(1n)),
			js: '(function(){let a=Object(1n);return [a,a]}())',
			json: '[[1,1],["Object",2],["BigInt","1"]]',
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'Number: NaN (repetition)',
			value: ((nan) => [nan, nan])(Object(NaN)),
			js: '(function(){let a=Object(NaN);return [a,a]}())',
			json: `[[1,1],["Object",${consts.NAN}]]`,
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'Object (repetition)',
			value: ((object) => [object, object])({}),
			js: '(function(){let a={};return [a,a]}())',
			json: '[[1,1],{}]',
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'empty Map (repetition)',
			value: ((map) => [map, map])(new Map()),
			js: '(function(){let a=new Map;return [a,a]}())',
			json: '[[1,1],["Map"]]',
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect(a.size).toBe(0);
			}
		},

		{
			name: 'empty Set (repetition)',
			value: ((set) => [set, set])(new Set()),
			js: '(function(){let a=new Set;return [a,a]}())',
			json: '[[1,1],["Set"]]',
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect(a.size).toBe(0);
			}
		},

		{
			name: 'RegExp (repetition)',
			value: ((regexp) => [regexp, regexp])(/regexp/),
			js: '(function(){let a=new RegExp("regexp");return [a,a]}())',
			json: '[[1,1],["RegExp","regexp"]]',
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'Date (repetition)',
			value: ((date) => [date, date])(new Date(1e12)),
			js: '(function(){let a=new Date(1000000000000);return [a,a]}())',
			json: '[[1,1],["Date","2001-09-09T01:46:40.000Z"]]',
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'Array buffer (repetition)',
			value: (() => {
				const uint8 = new Uint8Array(10);
				const uint16 = new Uint16Array(uint8.buffer);

				for (let i = 0; i < uint8.length; i += 1) {
					uint8[i] = i;
				}

				return [uint8, uint16];
			})(),
			js: '(function(){let a=new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer;return [new Uint8Array(a),new Uint16Array(a)]}())',
			json: '[[1,3],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="],["Uint16Array",2]]',
			validate: ([uint8, uint16]) => expect(uint8.buffer).toBe(uint16.buffer)
		},

		{
			name: 'TypedArray (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				return [uint8, uint8];
			})(),
			js: '(function(){let a=new Uint8Array([0,1,2,3,4,5,6,7,8,9]);return [a,a]}())',
			json: '[[1,1],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="]]',
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect([...a]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}
		},

		{
			name: 'Array Buffer and TypedArray (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const uint16 = new Uint16Array(uint8.buffer);
				return [uint8, uint8, uint16];
			})(),
			js: '(function(){let a=new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer,b=new Uint8Array(a);return [b,b,new Uint16Array(a)]}())',
			json: '[[1,1,3],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="],["Uint16Array",2]]',
			validate: ([uint8_a, uint8_b, uint16]) => {
				expect(uint8_a).toBe(uint8_b);
				expect(uint8_a.buffer).toBe(uint16.buffer);
				expect([...uint8_a]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}
		},

		{
			name: 'DataView (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const dv = new DataView(uint8.buffer);
				return [dv, dv];
			})(),
			js: '(function(){let a=new DataView(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer);return [a,a]}())',
			json: '[[1,1],["DataView",2],["ArrayBuffer","AAECAwQFBgcICQ=="]]',
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect([...new Uint8Array(a.buffer)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}
		},

		{
			name: 'Array Buffer and DataView (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const dv = new DataView(uint8.buffer);
				return [dv, dv, uint8.buffer];
			})(),
			js: '(function(){let a=new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer,b=new DataView(a);return [b,b,a]}())',
			json: '[[1,1,2],["DataView",2],["ArrayBuffer","AAECAwQFBgcICQ=="]]',
			validate: ([view_a, view_b, buffer]) => {
				expect(view_a).toBe(view_b);
				expect(view_a.buffer).toBe(buffer);
				expect([...new Uint8Array(buffer)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}
		},

		{
			name: 'DataView subview (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const dv = new DataView(uint8.buffer, 2, 4);
				return [dv, dv];
			})(),
			js: '(function(){let a=new DataView(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer,2,4);return [a,a]}())',
			json: '[[1,1],["DataView",2,2,4],["ArrayBuffer","AAECAwQFBgcICQ=="]]',
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect(a.byteOffset).toBe(2);
				expect(a.byteLength).toBe(4);
				expect([...new Uint8Array(a.buffer)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}
		},

		{
			name: 'BigInt64Array (repetition)',
			value: ((array) => [array, array])(new BigInt64Array([1n, 2n, 3n])),
			js: '(function(){let a=new BigInt64Array([1n,2n,3n]);return [a,a]}())',
			json: '[[1,1],["BigInt64Array",2],["ArrayBuffer","AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAA"]]',
			validate: ([a, b]) => expect(a).toBe(b)
		},

		{
			name: 'Temporal.Instant (repetition)',
			value: ((instant) => [instant, instant])(Temporal.Instant.from('1999-09-29T05:30:00Z')),
			js: '(function(){let a=Temporal.Instant.from("1999-09-29T05:30:00Z");return [a,a]}())',
			json: '[[1,1],["Temporal.Instant","1999-09-29T05:30:00Z"]]',
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect(a instanceof Temporal.Instant).toBeTruthy();
			}
		},

		{
			name: 'Map key (repetition)',
			value: (() => {
				const shared = { id: 1 };
				return [shared, new Map([[shared, 'v']])];
			})(),
			js: '(function(){let a={};a.id=1;return [a,new Map([[a,"v"]])]}())',
			json: '[[1,3],{"id":2},1,["Map",1,4],"v"]',
			validate: ([obj, map]) => expect([...map.keys()][0]).toBe(obj)
		},

		{
			name: 'Map keys (interlinked)',
			value: (() => {
				const node1 = { id: 1 };
				const node2 = { id: 2 };
				const node3 = { id: 3 };
				return new Map([
					[
						node1,
						new Map([
							[node2, 1],
							[node3, 1]
						])
					],
					[
						node2,
						new Map([
							[node1, 1],
							[node3, 1]
						])
					],
					[
						node3,
						new Map([
							[node1, 1],
							[node2, 1]
						])
					]
				]);
			})(),
			js: '(function(){let a={},b={},c={};a.id=3;b.id=2;c.id=1;return new Map([[c,new Map([[b,1],[a,1]])],[b,new Map([[c,1],[a,1]])],[a,new Map([[c,1],[b,1]])]])}())',
			json: '[["Map",1,3,4,8,6,9],{"id":2},1,["Map",4,2,6,2],{"id":5},2,{"id":7},3,["Map",1,2,6,2],["Map",1,2,4,2]]',
			validate: (map) => {
				const [node1, node2, node3] = map.keys();
				const from1 = [...map.get(node1).keys()];
				const from2 = [...map.get(node2).keys()];
				const from3 = [...map.get(node3).keys()];

				// each node appears as a key in the two sibling sub-maps;
				// the same object identity must be preserved everywhere
				expect(from2[0]).toBe(node1);
				expect(from3[0]).toBe(node1);
				expect(from1[0]).toBe(node2);
				expect(from3[1]).toBe(node2);
				expect(from1[1]).toBe(node3);
				expect(from2[1]).toBe(node3);
			}
		}
	],

	XSS: [
		{
			name: 'Dangerous string',
			value: `</script><script src='https://evil.com/script.js'>alert('pwned')</script><script>`,
			js: `"\\u003C/script>\\u003Cscript src='https://evil.com/script.js'>alert('pwned')\\u003C/script>\\u003Cscript>"`,
			json: `["\\u003C/script>\\u003Cscript src='https://evil.com/script.js'>alert('pwned')\\u003C/script>\\u003Cscript>"]`
		},
		{
			name: 'Dangerous key',
			value: { '<svg onload=alert("xss_works")>': 'bar' },
			js: '{"\\u003Csvg onload=alert(\\"xss_works\\")>":"bar"}',
			json: '[{"\\u003Csvg onload=alert(\\"xss_works\\")>":1},"bar"]'
		},
		{
			name: 'Dangerous regex',
			value: /[</script><script>alert('xss')//]/,
			js: `new RegExp("[\\u003C/script>\\u003Cscript>alert('xss')//]")`,
			json: `[["RegExp","[\\u003C/script>\\u003Cscript>alert('xss')//]"]]`
		},
		{
			name: 'Dangerous regex',
			value: (() => {
				const regex = /[</script><script>alert('xss')//]/;
				return [regex, regex];
			})(),
			js: `(function(){let a=new RegExp("[\\u003C/script>\\u003Cscript>alert('xss')//]");return [a,a]}())`,
			json: `[[1,1],["RegExp","[\\u003C/script>\\u003Cscript>alert('xss')//]"]]`,
			validate: ([a, b]) => {
				expect(a).toBe(b);
				expect(a.source).toBe("[</script><script>alert('xss')//]");
			}
		}
	],

	misc: [
		{
			name: 'Object without prototype',
			value: Object.create(null),
			js: '{__proto__:null}',
			json: '[["null"]]',
			validate: (value) => {
				expect(Object.getPrototypeOf(value)).toEqual(null);
				expect(Object.keys(value).length).toEqual(0);
			}
		},
		{
			name: 'cross-realm POJO',
			value: vm.runInNewContext('({})'),
			js: '{}',
			json: '[{}]',
			validate: (value) => {
				expect(Object.getPrototypeOf(value)).toEqual(Object.prototype);
				expect(Object.keys(value).length).toEqual(0);
			}
		},
		{
			name: 'non-enumerable symbolic key',
			value: (() => {
				const obj = { x: 1 };
				Object.defineProperty(obj, Symbol('key'), {
					value: 'value',
					enumerable: false
				});
				return obj;
			})(),
			js: '{x:1}',
			json: '[{"x":1},1]'
		}
	],

	custom: ((instance) => [
		{
			name: 'Custom type',
			value: [instance, instance],
			js: '(function(){let a=new Foo({bar:new Bar({answer:42})});return [a,a]}())',
			json: '[[1,1],["Foo",2],{"bar":3},["Bar",4],{"answer":5},42]',
			replacer: (value, js) => {
				if (value instanceof Foo) {
					return js`new Foo(${value.value})`;
				}

				if (value instanceof Bar) {
					return js`new Bar(${value.value})`;
				}
			},
			// test for https://github.com/Rich-Harris/devalue/pull/80
			reducers: Object.assign(Object.create({ polluted: true }), {
				Foo: (x) => x instanceof Foo && x.value,
				Bar: (x) => x instanceof Bar && x.value
			}),
			revivers: {
				Foo: (x) => new Foo(x),
				Bar: (x) => new Bar(x)
			},
			validate: ([obj1, obj2]) => {
				expect(obj1).toBe(obj2);
				expect(obj1 instanceof Foo).toBeTruthy();
				expect(obj1.value.bar instanceof Bar).toBeTruthy();
				expect(obj1.value.bar.value.answer).toEqual(42);
			},
			evaluate: (source) => new Function('Foo', 'Bar', `return (${source})`)(Foo, Bar)
		}
	])(new Foo({ bar: new Bar({ answer: 42 }) })),

	custom_fallback: ((date) => [
		{
			name: 'Custom fallback',
			value: date,
			js: "new Date('')",
			json: '[["Date",""]]',
			replacer: (value, js) => value instanceof Date && js`new Date('')`,
			reducers: {
				Date: (value) => value instanceof Date && ''
			},
			revivers: {
				Date: (value) => new Date(value)
			},
			validate: (obj) => {
				expect(obj instanceof Date).toBeTruthy();
				expect(isNaN(obj.getDate())).toBeTruthy();
			}
		}
	])(new Date('invalid')),

	functions: (() => {
		// Simple function wrapper class for testing
		class FunctionRef {
			constructor(fn) {
				this.fn = fn;
			}
		}

		const testFn = (x) => x * 2;

		return [
			{
				name: 'Function wrapped in custom type',
				value: new FunctionRef(testFn),
				js: 'new FunctionRef((x) => x * 2)',
				json: '[["FunctionRef",1],"(x) => x * 2"]',
				replacer: (value, js) => {
					if (value instanceof FunctionRef) {
						return js`new FunctionRef((x) => x * 2)`;
					}
				},
				reducers: {
					FunctionRef: (value) => {
						if (value instanceof FunctionRef) {
							// Serialize the function code as a string
							return value.fn.toString();
						}
					}
				},
				revivers: {
					FunctionRef: (code) => {
						// Reconstruct the function from its string representation
						const fn = new Function('return ' + code)();
						return new FunctionRef(fn);
					}
				},
				validate: (result) => {
					expect(result instanceof FunctionRef).toBeTruthy();
					expect(typeof result.fn === 'function').toBeTruthy();
					// Test that the function works
					expect(result.fn(5)).toEqual(10);
				},
				evaluate: (source) => new Function('FunctionRef', `return (${source})`)(FunctionRef)
			},
			{
				name: 'Function in nested structure',
				value: { fn: testFn, nested: { data: 42 } },
				js: '{fn:(x) => x * 2,nested:{data:42}}',
				json: '[{"fn":1,"nested":3},["FunctionRef",2],"(x) => x * 2",{"data":4},42]',
				replacer: (value, js) => {
					if (typeof value === 'function') {
						return js`(x) => x * 2`;
					}
				},
				reducers: {
					FunctionRef: (value) => {
						if (typeof value === 'function') {
							return value.toString();
						}
					}
				},
				revivers: {
					FunctionRef: (code) => {
						return new Function('return ' + code)();
					}
				},
				validate: (result) => {
					expect(typeof result.fn === 'function').toBeTruthy();
					expect(result.nested.data).toEqual(42);
					expect(result.fn(3)).toEqual(6);
				}
			}
		];
	})()
};

const exact_uneval_numbers = new Set([
	'number: NaN',
	'number: +Infinity',
	'number: -Infinity',
	'number: negative zero',
	'Number: NaN',
	'Number: +Infinity',
	'Number: -Infinity',
	'Number: negative zero'
]);

/**
 * @param {any} fixture
 * @param {any} actual
 */
function validate_fixture(fixture, actual) {
	if (fixture.validate) {
		fixture.validate(actual);
	} else {
		expect(actual).toEqual(fixture.value);
	}
}

/**
 * @param {any} fixture
 * @param {string} source
 */
function evaluate_fixture(fixture, source) {
	return fixture.evaluate ? fixture.evaluate(source) : (0, eval)(`(${source})`);
}

/**
 * @param {() => void} fn
 */
function catch_error(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}

	expect.unreachable('expected operation to throw');
}

/**
 * @param {() => Promise<any>} fn
 */
async function catch_async_error(fn) {
	try {
		await fn();
	} catch (error) {
		return error;
	}

	expect.unreachable('expected operation to reject');
}

describe.each(Object.entries(fixtures))('uneval: %s', (name, tests) => {
	test.each(tests.map((t) => [t.name, t]))('%s', (_name, t) => {
		const source = uneval(t.value, t.replacer);

		if (name === 'strings' || name === 'XSS' || exact_uneval_numbers.has(t.name)) {
			expect(source).toEqual(t.js);
		}

		validate_fixture(t, evaluate_fixture(t, source));
	});
});

describe('uneval: custom source', () => {
	test.each([false, true])(
		'does not shadow constructors in literal or nested source (nested=%s)',
		(nested) => {
			class Wrapper {
				constructor(inner) {
					this.inner = inner;
				}
			}

			const shared = { answer: 42 };
			const source = uneval([shared, shared, new Wrapper(shared)], (value, js) => {
				if (!(value instanceof Wrapper)) return;
				const source = js`new a(${value.inner})`;
				return nested ? js`(${source})` : source;
			});
			const result = vm.runInNewContext(source, { a: Wrapper });
			expect(result[0]).toBe(result[1]);
			expect(result[2]).toBeInstanceOf(Wrapper);
			expect(result[2].inner).toBe(result[0]);
		}
	);
	test('literal local bindings do not capture serialized references', () => {
		class Wrapper {
			constructor(inner, total) {
				this.inner = inner;
				this.total = total;
			}
		}

		const shared = { answer: 42 };
		const source = uneval([shared, shared, new Wrapper(shared, 3)], (value, js) => {
			if (value instanceof Wrapper) {
				return js`(()=>{const a=1,b=2;return new Wrapper(${value.inner},a+b)})()`;
			}
		});
		const result = vm.runInNewContext(source, { Wrapper });
		expect(result[0]).toBe(result[1]);
		expect(result[2].inner).toBe(result[0]);
		expect(result[2].total).toBe(3);
	});
	test('names allocated while breaking custom cycles do not shadow literal names', () => {
		class Wrapper {
			constructor(inner) {
				this.inner = inner;
			}
		}

		const container = {};
		const wrapper = new Wrapper(container);
		container.wrapper = wrapper;
		const source = uneval(wrapper, (value, js) => {
			if (value instanceof Wrapper) return js`new b(${value.inner})`;
		});
		const result = vm.runInNewContext(source, { b: Wrapper });
		expect(result).toBeInstanceOf(Wrapper);
		expect(result.inner.wrapper).toBe(result);
	});
	test('reserves dollar and underscore names in literal source', () => {
		class Wrapper {
			constructor(inner) {
				this.inner = inner;
			}
		}

		const shared = Array.from({ length: 54 }, () => ({}));
		const source = uneval([shared, shared.slice(), new Wrapper(42)], (value, js) => {
			if (value instanceof Wrapper) return js`new $(_(${value.inner}))`;
		});
		const result = vm.runInNewContext(source, { $: Wrapper, _: (value) => value });
		for (let i = 0; i < shared.length; i += 1) expect(result[0][i]).toBe(result[1][i]);
		expect(result[2]).toBeInstanceOf(Wrapper);
		expect(result[2].inner).toBe(42);
	});
	test.each([false, true])(
		'reserves escaped identifiers in literal source (code_point=%s)',
		(code_point) => {
			class Wrapper {
				constructor(inner) {
					this.inner = inner;
				}
			}

			const shared = { answer: 42 };
			const source = uneval([shared, shared, new Wrapper(shared)], (value, js) => {
				if (!(value instanceof Wrapper)) return;
				return code_point ? js`new \u{61}(${value.inner})` : js`new \u0061(${value.inner})`;
			});
			const result = vm.runInNewContext(source, { a: Wrapper });
			expect(result[0]).toBe(result[1]);
			expect(result[2]).toBeInstanceOf(Wrapper);
			expect(result[2].inner).toBe(result[0]);
		}
	);
	test('preserves identities referenced by custom source', () => {
		class Wrapper {
			constructor(inner) {
				this.inner = inner;
			}
		}
		const shared = { hello: 'world' };
		const source = uneval({ wrapped: new Wrapper(shared), shared }, (value, js) =>
			value instanceof Wrapper ? js`new Wrapper(${value.inner})` : undefined
		);
		const result = eval(source);
		expect(result.wrapped.inner).toBe(result.shared);
	});
	test('constructs a repeated wrapper after its shared child is populated', () => {
		class Wrapper {
			static calls = 0;

			constructor(inner) {
				Wrapper.calls += 1;
				this.inner = inner;
				this.answer = inner.answer;
			}
		}

		const child = { answer: 42 };
		const wrapper = new Wrapper(child);
		Wrapper.calls = 0;
		let replacer_calls = 0;
		const source = uneval([wrapper, wrapper, child], (value, js) => {
			if (value instanceof Wrapper) {
				replacer_calls += 1;
				return js`new Wrapper(${value.inner})`;
			}
		});
		const result = vm.runInNewContext(source, { Wrapper });

		expect(replacer_calls).toBe(1);
		expect(Wrapper.calls).toBe(1);
		expect(result[0]).toBe(result[1]);
		expect(result[0].inner).toBe(result[2]);
		expect(result[0].answer).toBe(42);
	});
	test('orders nested custom dependencies', () => {
		class Inner {
			static calls = 0;

			constructor(value) {
				Inner.calls += 1;
				this.value = value;
			}
		}
		class Outer {
			static calls = 0;

			constructor(inner) {
				Outer.calls += 1;
				this.inner = inner;
				this.answer = inner.value.answer;
			}
		}

		const child = { answer: 42 };
		const inner = new Inner(child);
		const outer = new Outer(inner);
		Inner.calls = 0;
		Outer.calls = 0;
		const replacer_calls = new Map();
		const source = uneval([outer, outer, inner, inner, child], (value, js) => {
			if (value instanceof Outer) {
				replacer_calls.set(value, (replacer_calls.get(value) ?? 0) + 1);
				return js`new Outer(${value.inner})`;
			}
			if (value instanceof Inner) {
				replacer_calls.set(value, (replacer_calls.get(value) ?? 0) + 1);
				return js`new Inner(${value.value})`;
			}
		});
		const result = vm.runInNewContext(source, { Inner, Outer });

		expect(replacer_calls.get(inner)).toBe(1);
		expect(replacer_calls.get(outer)).toBe(1);
		expect(Inner.calls).toBe(1);
		expect(Outer.calls).toBe(1);
		expect(result[0]).toBe(result[1]);
		expect(result[0].inner).toBe(result[2]);
		expect(result[2]).toBe(result[3]);
		expect(result[2].value).toBe(result[4]);
		expect(result[0].answer).toBe(42);
	});
	test('finds custom dependencies inside inline containers', () => {
		class Inner {
			static calls = 0;

			constructor(value) {
				Inner.calls += 1;
				this.value = value;
			}
		}
		class Outer {
			static calls = 0;

			constructor(options) {
				Outer.calls += 1;
				this.inner = options.inner;
				this.answer = options.inner.value.answer;
			}
		}

		const inner = new Inner({ answer: 42 });
		const outer = new Outer({ inner });
		Inner.calls = 0;
		Outer.calls = 0;
		const source = uneval([outer, outer, inner], (value, js) => {
			if (value instanceof Outer) return js`new Outer(${{ inner: value.inner }})`;
			if (value instanceof Inner) return js`new Inner(${value.value})`;
		});
		const result = vm.runInNewContext(source, { Inner, Outer });

		expect(Inner.calls).toBe(1);
		expect(Outer.calls).toBe(1);
		expect(result[0]).toBe(result[1]);
		expect(result[0].inner).toBe(result[2]);
		expect(result[0].answer).toBe(42);
	});
	test('preserves a child used by multiple source holes', () => {
		class Pair {
			constructor(left, right) {
				this.left = left;
				this.right = right;
			}
		}

		const child = { answer: 42 };
		const source = uneval(new Pair(child, child), (value, js) =>
			value instanceof Pair ? js`new Pair(${value.left},${value.right})` : undefined
		);
		const result = vm.runInNewContext(source, { Pair });

		expect(result.left).toBe(result.right);
		expect(result.left.answer).toBe(42);
	});
	test('constructs a dependency-free repeated custom value once', () => {
		class Wrapper {
			static calls = 0;

			constructor() {
				Wrapper.calls += 1;
			}
		}

		const wrapper = new Wrapper();
		Wrapper.calls = 0;
		let replacer_calls = 0;
		const source = uneval([wrapper, wrapper], (value, js) => {
			if (value instanceof Wrapper) {
				replacer_calls += 1;
				return js`new Wrapper()`;
			}
		});

		const result = vm.runInNewContext(source, { Wrapper });
		expect(replacer_calls).toBe(1);
		expect(Wrapper.calls).toBe(1);
		expect(result[0]).toBe(result[1]);
	});
	test('orders a shared typed view after its backing buffer', () => {
		class Wrapper {
			static calls = 0;

			constructor(view, buffer) {
				Wrapper.calls += 1;
				this.view = view;
				this.buffer = buffer;
				this.first = view[0];
			}
		}

		const view = new Uint8Array([1, 2, 3]);
		const wrapper = new Wrapper(view, view.buffer);
		Wrapper.calls = 0;
		let replacer_calls = 0;
		const source = uneval([wrapper, wrapper, view, view.buffer], (value, js) => {
			if (value instanceof Wrapper) {
				replacer_calls += 1;
				return js`new Wrapper(${value.view},${value.buffer})`;
			}
		});
		const result = vm.runInNewContext(source, { Wrapper });

		expect(replacer_calls).toBe(1);
		expect(Wrapper.calls).toBe(1);
		expect(result[0]).toBe(result[1]);
		expect(result[0].view).toBe(result[2]);
		expect(result[2].buffer).toBe(result[3]);
		expect(result[0].buffer).toBe(result[3]);
		expect(result[0].first).toBe(1);
	});
	test('reconstructs custom cycles through mutable containers', () => {
		class Wrapper {
			static calls = 0;

			constructor(inner) {
				Wrapper.calls += 1;
				this.inner = inner;
			}
		}

		const container = {};
		const wrapper = new Wrapper(container);
		container.wrapper = wrapper;
		Wrapper.calls = 0;
		let replacer_calls = 0;
		const source = uneval(wrapper, (value, js) => {
			if (value instanceof Wrapper) {
				replacer_calls += 1;
				return js`new Wrapper(${value.inner})`;
			}
		});
		const result = vm.runInNewContext(source, { Wrapper });

		expect(replacer_calls).toBe(1);
		expect(Wrapper.calls).toBe(1);
		expect(result.inner.wrapper).toBe(result);
	});
	describe.each([
		{ name: 'Object.prototype', prototype: Object.prototype },
		{ name: 'null prototype', prototype: null }
	])('$name', ({ prototype }) => {
		test.each(['first', 'middle', 'last'])(
			'preserves property order around cyclic references (%s)',
			(position) => {
				class Marker {}

				const value = Object.create(prototype);
				const completed = { done: true };
				if (position !== 'first') value.before = completed;
				value.self = value;
				if (position !== 'last') value.after = 42;

				const source = uneval([value, new Marker()], (item, js) =>
					item instanceof Marker ? js`new Marker()` : undefined
				);
				const [result] = vm.runInNewContext(source, { Marker });
				const expected = [
					...(position === 'first' ? [] : ['before']),
					'self',
					...(position === 'last' ? [] : ['after'])
				];

				expect(Object.keys(result)).toEqual(expected);
				expect(result.self).toBe(result);
				if (position !== 'first') expect(result.before.done).toBe(true);
			}
		);
	});
	test.each(['first', 'middle', 'last'])(
		'preserves Map and Set order around cyclic references (%s)',
		(position) => {
			class Marker {}

			const completed = { done: true };
			const map = new Map();
			if (position !== 'first') map.set('before', completed);
			map.set('self', map);
			if (position !== 'last') map.set('after', 42);

			const set = new Set();
			if (position !== 'first') set.add(completed);
			set.add(set);
			if (position !== 'last') set.add(42);

			const source = uneval([map, set, new Marker()], (item, js) =>
				item instanceof Marker ? js`new Marker()` : undefined
			);
			const [result_map, result_set] = vm.runInNewContext(source, { Marker });
			const map_entries = Array.from(result_map);
			const set_values = Array.from(result_set);

			expect(map_entries.map(([key]) => key)).toEqual([
				...(position === 'first' ? [] : ['before']),
				'self',
				...(position === 'last' ? [] : ['after'])
			]);
			expect(map_entries[position === 'first' ? 0 : 1][1]).toBe(result_map);
			expect(set_values[position === 'first' ? 0 : 1]).toBe(result_set);
			if (position !== 'first') {
				expect(map_entries[0][1].done).toBe(true);
				expect(set_values[0].done).toBe(true);
			}
			if (position !== 'last') {
				expect(map_entries.at(-1)[1]).toBe(42);
				expect(set_values.at(-1)).toBe(42);
			}
		}
	);
	test('preserves order in mutual and custom cycles', () => {
		class Wrapper {
			constructor(inner) {
				this.inner = inner;
				this.before = inner.before.done;
			}
		}

		const left = {};
		const right = {};
		left.peer = right;
		left.tail = 'left';
		right.peer = left;
		right.tail = 'right';

		const container = {};
		container.before = { done: true };
		const wrapper = new Wrapper(container);
		container.wrapper = wrapper;
		container.tail = 42;

		const source = uneval([left, right, wrapper], (item, js) =>
			item instanceof Wrapper ? js`new Wrapper(${item.inner})` : undefined
		);
		const [result_left, result_right, result_wrapper] = vm.runInNewContext(source, { Wrapper });

		expect(Object.keys(result_left)).toEqual(['peer', 'tail']);
		expect(Object.keys(result_right)).toEqual(['peer', 'tail']);
		expect(result_left.peer).toBe(result_right);
		expect(result_right.peer).toBe(result_left);
		expect(Object.keys(result_wrapper.inner)).toEqual(['before', 'wrapper', 'tail']);
		expect(result_wrapper.inner.wrapper).toBe(result_wrapper);
		expect(result_wrapper.before).toBe(true);
		expect(result_wrapper.inner.tail).toBe(42);
	});
	test.each(['mutual', 'self'])(
		'rejects cycles made entirely of custom constructions (%s)',
		(kind) => {
			class Atomic {
				constructor() {
					this.other = undefined;
				}
			}

			const a = new Atomic();
			const b = new Atomic();
			a.other = b;
			b.other = a;
			const self = new Atomic();
			self.other = self;
			const value = kind === 'mutual' ? a : self;
			const error = catch_error(() =>
				uneval(value, (item, js) =>
					item instanceof Atomic ? js`Object.assign(new Atomic(),{other:${item.other}})` : undefined
				)
			);
			expect(error).toMatchObject({
				name: 'RangeError',
				message: 'Maximum call stack size exceeded'
			});
		}
	);
	test.each([undefined, null, false])('accepts documented fallback %s', (fallback) => {
		expect(uneval({ answer: 42 }, () => fallback)).toBe('{answer:42}');
	});

	test.each([
		{ name: 'empty string', invalid: '' },
		{ name: 'zero', invalid: 0 },
		{ name: 'NaN', invalid: NaN },
		{ name: 'zero bigint', invalid: 0n }
	])('rejects undocumented fallback $name', ({ invalid }) => {
		const error = catch_error(() => uneval({ answer: 42 }, () => invalid));
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe('Invalid uneval replacer result');
	});

	test.each([
		{ name: 'one', invalid: 1 },
		{ name: 'true', invalid: true },
		{ name: 'source string', invalid: 'new Date()' },
		{ name: 'Promise', invalid: Promise.resolve() },
		{ name: 'object', invalid: {} }
	])('rejects invalid fragment $name', ({ invalid }) => {
		const error = catch_error(() => uneval({ answer: 42 }, () => invalid));
		expect(error).toBeInstanceOf(TypeError);
		expect(error.message).toBe('Invalid JavaScript fragment');
	});
	test('treats replacer results as expressions', () => {
		class Replacement {
			constructor(source) {
				this.source = source;
			}
		}

		const comma = new Replacement('comma');
		const conditional = new Replacement('conditional');
		const object = new Replacement('object');
		const nested = new Replacement('nested');
		const escaped = new Replacement('escaped');
		const slashes = new Replacement('slashes');
		const block = new Replacement('block');
		const partial = new Replacement('partial');
		const source = uneval(
			[comma, conditional, object, nested, escaped, slashes, block, partial],
			(value, js) => {
				if (!(value instanceof Replacement)) return;
				switch (value.source) {
					case 'comma':
						return js`(1,2)`;
					case 'conditional':
						return js`false?1:2`;
					case 'object':
						return js`{answer:42}`;
					case 'nested':
						return js`${js`Math.max(`}${1},${2}${js`)`}`;
					case 'escaped':
						return js`${'</script>'}`;
					case 'slashes':
						return js`"https://example.com//path"`;
					case 'block':
						return js`/* before */ ({answer:42}) /* after */`;
					case 'partial':
						return js`${js`(()=>{ // comment from a partial fragment`}${js`\nreturn `}${42}${js`;})()`}`;
				}
			}
		);
		const result = vm.runInNewContext(source);

		expect(result.length).toBe(8);
		expect(result[0]).toBe(2);
		expect(result[1]).toBe(2);
		expect(result[2].answer).toBe(42);
		expect(result[3]).toBe(2);
		expect(result[4]).toBe('</script>');
		expect(result[5]).toBe('https://example.com//path');
		expect(result[6].answer).toBe(42);
		expect(result[7]).toBe(42);
		expect(!source.includes('</script>')).toBeTruthy();
	});
	test.each([
		{ name: 'string', invoke: (js) => js('new Date()') },
		{ name: 'array', invoke: (js) => js(['new Date()']) }
	])('requires js to be used as a tagged template ($name argument)', ({ invoke }) => {
		expect(() =>
			uneval(new Date(), (value, js) => (value instanceof Date ? invoke(js) : undefined))
		).toThrow(/^`js` must be used as a tagged template, but was called as a regular function$/);
	});
});

describe.each(Object.entries(fixtures))('stringify: %s', (_name, tests) => {
	test.each(tests.map((t) => [t.name, t]))('%s', (_name, t) => {
		const actual = stringify(t.value, t.reducers);
		const expected = t.json;
		expect(actual).toEqual(expected);
	});
});

describe('parse wrapper', () => {
	test('parses normal input', () => {
		expect(parse('[{"answer":1},42]')).toEqual({ answer: 42 });
	});

	test('forwards primitive sentinels', () => {
		expect(parse(`${consts.UNDEFINED}`)).toBe(undefined);
	});

	test('forwards revivers', () => {
		class Answer {
			constructor(value) {
				this.value = value;
			}
		}

		const actual = parse('[["Answer",1],42]', {
			Answer: (value) => new Answer(value)
		});

		expect(actual instanceof Answer).toBeTruthy();
		expect(actual.value).toBe(42);
	});
});

describe.each(Object.entries(fixtures))('unflatten: %s', (_name, tests) => {
	test.each(tests.map((t) => [t.name, t]))('%s', (_name, t) => {
		const actual = unflatten(JSON.parse(t.json), t.revivers);
		validate_fixture(t, actual);
	});
});

const invalid = [
	{
		name: 'typed array with non-ArrayBuffer input',
		json: '[["Int8Array", 1], { "length": 2 }, 1000000000]',
		message: 'Invalid data'
	},
	{
		name: 'typed array with out-of-bounds buffer index',
		json: '[["Uint8Array", 9, 0, 1]]',
		message: 'Invalid data'
	},
	{
		name: 'typed array with negative buffer index',
		json: '[["Uint8Array", -1, 0, 1]]',
		message: 'Invalid data'
	},
	{
		name: 'typed array with null buffer',
		json: '[["Uint8Array", 1, 0, 1], null]',
		message: 'Invalid data'
	},
	{
		name: 'typed array with non-numeric buffer index',
		json: '[["Uint8Array", "1", 0, 1], ["ArrayBuffer", "AQID"]]',
		message: 'Invalid data'
	},
	{
		name: 'DataView with out-of-bounds buffer index',
		json: '[["DataView", 4, 0, 1]]',
		message: 'Invalid data'
	},
	{
		name: 'boxed primitive wrapping null',
		json: '[["Object", 1], null]',
		message: 'Invalid input'
	},
	{
		name: 'boxed primitive with out-of-bounds index',
		json: '[["Object", 9]]',
		message: 'Invalid input'
	},
	{
		name: 'boxed primitive with unboxable sentinel',
		json: `[["Object", ${consts.UNDEFINED}]]`,
		message: 'Invalid input'
	},
	{
		name: 'boxed primitive with non-numeric index',
		json: '[["Object", "1"], 1]',
		message: 'Invalid input'
	},
	{
		name: 'ArrayBuffer with non-string value',
		json: '[["ArrayBuffer", { "length": 100 }]]',
		message: 'Invalid ArrayBuffer encoding'
	},
	{
		name: 'empty string',
		json: '',
		error: SyntaxError
	},
	{
		name: 'invalid JSON',
		json: '][',
		error: SyntaxError
	},
	{
		name: 'hole',
		json: `${consts.HOLE}`,
		message: 'Invalid input'
	},
	{
		name: 'string',
		json: '"hello"',
		message: 'Invalid input'
	},
	{
		name: 'number',
		json: '42',
		message: 'Invalid input'
	},
	{
		name: 'boolean',
		json: 'true',
		message: 'Invalid input'
	},
	{
		name: 'null',
		json: 'null',
		message: 'Invalid input'
	},
	{
		name: 'object',
		json: '{}',
		message: 'Invalid input'
	},
	{
		name: 'empty array',
		json: '[]',
		message: 'Invalid input'
	},
	{
		name: 'prototype pollution',
		json: '[{"__proto__":1},{}]',
		message: 'Cannot parse an object with a `__proto__` property'
	},
	{
		name: 'sparse array prototype pollution',
		json: `[[${consts.SPARSE},1,"__proto__",{}]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array non-integer index',
		json: `[[${consts.SPARSE},5,"foo",1]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array negative index',
		json: `[[${consts.SPARSE},5,-1,1]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array out-of-bounds index',
		json: `[[${consts.SPARSE},2,5,1]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array non-integer length',
		json: `[[${consts.SPARSE},"abc"]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array negative length',
		json: `[[${consts.SPARSE},-3]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array float length',
		json: `[[${consts.SPARSE},1.5]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array float index',
		json: `[[${consts.SPARSE},5,1.5,1]]`,
		message: 'Invalid input'
	},
	{
		name: 'prototype pollution via null-prototype object',
		json: '[["null","__proto__",1],{}]',
		message: 'Cannot parse an object with a `__proto__` property'
	},
	{
		name: 'nested prototype pollution via null-prototype object',
		json: '[{"data":1},["null","__proto__",2],{"polluted":3},true]',
		message: 'Cannot parse an object with a `__proto__` property'
	},
	{
		name: 'prototype pollution via Object wrapper',
		json: '[["Object",{"__proto__":1}],{}]',
		message: 'Invalid input'
	},
	{
		name: 'nested prototype pollution via Object wrapper',
		json: '[{"wrapped":1},["Object",{"__proto__":2}],{}]',
		message: 'Invalid input'
	},
	{
		name: 'bad index',
		json: '[{"0":1,"toString":"push"},"hello"]',
		message: 'Invalid input'
	},
	{
		name: 'TypedArray self-reference',
		json: '[["Uint8Array", 0]]',
		message: 'Invalid data'
	},
	{
		name: 'custom reviver self-reference',
		json: '[["Custom", 0]]',
		revivers: { Custom: (v) => v },
		message: 'Invalid circular reference'
	},
	{
		name: 'mutual TypedArray reference',
		json: '[["Uint8Array", 1], ["Uint8Array", 0]]',
		message: 'Invalid data'
	}
];

test.each(invalid.map((t) => [t.name, t]))(
	'parse error: %s',
	(_name, { json, message, error: ErrorType, revivers }) => {
		const error = catch_error(() => parse(json, revivers));
		if (ErrorType) {
			expect(error).toBeInstanceOf(ErrorType);
		} else {
			expect(error).toMatchObject({ message });
		}
	}
);

test.each(['["__proto__"]', '[["__proto__"]]', '[]', '{}', '0', 'true', 'null'])(
	'rejects null-prototype object key %s',
	(key) => {
		const json = `[["null",${key},1],{"isAdmin":2},true]`;
		const message = 'Cannot parse an object with a non-string key';

		assert.throws(
			() => parse(json),
			(error) => error.message === message
		);
		assert.throws(
			() => unflatten(JSON.parse(json)),
			(error) => error.message === message
		);
	}
);

test('rejects coerced __proto__ keys in nested null-prototype objects', () => {
	const json = '[{"data":1},["null",["__proto__"],2],{"isAdmin":3},true]';
	const message = 'Cannot parse an object with a non-string key';

	assert.throws(
		() => parse(json),
		(error) => error.message === message
	);
	assert.throws(
		() => unflatten(JSON.parse(json)),
		(error) => error.message === message
	);
});

test.each([parse, unflatten].map((fn) => ({ fn })))(
	'$fn.name: null-prototype objects retain valid string keys',
	({ fn }) => {
		const input = Object.assign(Object.create(null), {
			'': 'empty',
			0: 'numeric',
			constructor: 'constructor',
			toString: 'toString'
		});
		const json = stringify(input);

		const result = fn(fn === parse ? json : JSON.parse(json));
		expect(Object.getPrototypeOf(result)).toBe(null);
		expect(result).toStrictEqual(input);
	}
);

describe.each([uneval, stringify].map((fn) => ({ fn })))('$fn.name', ({ fn }) => {
	test('throws for non-POJOs', () => {
		class Foo {}
		const foo = new Foo();
		expect(() => fn(foo)).toThrow();
	});

	test('throws for Symbols', () => {
		expect(() => fn(Symbol('foo'))).toThrow();
	});

	test('throws for boxed Symbols', () => {
		expect(() => fn(Object(Symbol('foo')))).toThrow();
	});

	test('throws for symbolic keys', () => {
		expect(() => fn({ [Symbol()]: null })).toThrow();
	});

	test('throws for __proto__ keys', () => {
		const inner = JSON.parse('{"__proto__":1}');
		const root = { foo: inner };
		const error = catch_error(() => fn(root));
		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify objects with __proto__ keys');
		expect(error.path).toEqual('.foo');
		expect(error.value).toBe(inner);
		expect(error.root).toBe(root);
	});

	test('reports function diagnostic context', () => {
		const value = function invalid() {};
		const root = { foo: { array: [value] } };
		const error = catch_error(() => fn(root));

		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify a function');
		expect(error.path).toEqual('.foo.array[0]');
		expect(error.value).toBe(value);
		expect(error.root).toBe(root);
	});

	test('reports non-POJO diagnostic context', () => {
		class Whatever {}
		const value = new Whatever();
		const root = { foo: { ['string-key']: new Map([['key', value]]) } };
		const error = catch_error(() => fn(root));

		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify arbitrary non-POJOs');
		expect(error.path).toEqual('.foo["string-key"].get("key")');
		expect(error.value).toBe(value);
		expect(error.root).toBe(root);
	});

	test('populates error.path after maps (#64)', () => {
		const value = function invalid() {};
		const root = {
			map: new Map([['key', 'value']]),
			object: { invalid: value }
		};
		const error = catch_error(() => fn(root));

		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify a function');
		expect(error.path).toEqual('.object.invalid');
		expect(error.value).toBe(value);
		expect(error.root).toBe(root);
	});

	test('reports symbolic-key diagnostic context', () => {
		const symbolKey = Symbol('key');
		const root = { [symbolKey]: 'value' };
		const error = catch_error(() => fn(root));

		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify POJOs with symbolic keys');
		expect(error.path).toEqual('');
		expect(error.value).toBe(root);
		expect(error.root).toBe(root);
	});
});

test('handles very sparse arrays efficiently', () => {
	const arr = [];
	arr[1_000_000] = 'x';

	// This should complete nearly instantly, not iterate 1M times
	const start = performance.now();
	const json = stringify(arr);
	const elapsed = performance.now() - start;

	expect(elapsed < 100, `stringify took ${elapsed}ms, expected < 100ms`).toBeTruthy();

	// Verify round-trip
	const result = parse(json);
	expect(result.length).toBe(1_000_001);
	expect(result[1_000_000]).toBe('x');
	expect(!(0 in result)).toBeTruthy();

	// Verify uneval too
	const start2 = performance.now();
	const js = uneval(arr);
	const elapsed2 = performance.now() - start2;
	expect(elapsed2 < 100, `uneval took ${elapsed2}ms, expected < 100ms`).toBeTruthy();
});

test.each(['empty', 'single', 'shared', 'cyclic'])(
	'uneval does not scan sparse array holes (%s)',
	(kind) => {
		const length = 2 ** 32 - 1;
		const index = length - 1;
		const array = parse(kind === 'empty' ? `[[-7,${length}]]` : `[[-7,${length},${index},1],42]`);

		// Count property probes rather than relying on wall-clock timings. This
		// also bounds the work if either traversal regresses to scanning holes.
		let probes = 0;
		function probe() {
			expect(++probes <= 100, 'uneval should only inspect populated indices').toBeTruthy();
		}

		const proxy = new Proxy(array, {
			get(target, key, receiver) {
				probe();
				return Reflect.get(target, key, receiver);
			},
			has(target, key) {
				probe();
				return Reflect.has(target, key);
			},
			getOwnPropertyDescriptor(target, key) {
				probe();
				return Reflect.getOwnPropertyDescriptor(target, key);
			}
		});

		if (kind === 'cyclic') array[index] = proxy;

		const js = uneval(kind === 'shared' ? [proxy, proxy] : proxy);
		expect(js.length < 150, 'sparse output should stay compact').toBeTruthy();
		const result = (0, eval)(js);
		const restored = kind === 'shared' ? result[0] : result;

		expect(restored.length).toBe(length);
		expect(Object.keys(restored)).toStrictEqual(kind === 'empty' ? [] : [String(index)]);
		if (kind !== 'empty') expect(restored[index]).toBe(kind === 'cyclic' ? restored : 42);
		if (kind === 'shared') expect(result[0]).toBe(result[1]);
	}
);

test.each([
	{ length: 3, shared: false },
	{ length: 3, shared: true },
	{ length: 1000, shared: false },
	{ length: 1000, shared: true }
])(
	'uneval ignores inherited array elements (length=$length, shared=$shared)',
	({ length, shared }) => {
		const proto = Object.create(Array.prototype);
		for (const index of [1, length - 1]) {
			Object.defineProperty(proto, index, {
				enumerable: index === 1,
				get() {
					throw new Error('inherited array elements should not be read');
				}
			});
		}
		const array = [42];
		array.length = length;
		Object.setPrototypeOf(array, proto);

		const result = (0, eval)(uneval(shared ? [array, array] : array));
		const restored = shared ? result[0] : result;
		expect(restored.length).toBe(length);
		expect(Object.keys(restored)).toStrictEqual(['0']);
		expect(restored[0]).toBe(42);
		if (shared) expect(result[0]).toBe(result[1]);
	}
);

test('uneval ignores non-index properties on shared arrays', () => {
	const array = [42];
	for (const key of ['foo', '-1', '01', '1e0', '1.5', '4294967295', Symbol('key')]) {
		Object.defineProperty(array, key, {
			enumerable: true,
			get() {
				throw new Error('non-index array properties should not be read');
			}
		});
	}

	const result = (0, eval)(uneval([array, array]));
	expect(result).toStrictEqual([[42], [42]]);
	expect(result[0]).toBe(result[1]);
});

test('uneval reports the path of invalid sparse array elements', () => {
	const array = [];
	const value = () => {};
	array[99_999_999] = value;
	const root = { array };

	assert.throws(
		() => uneval(root),
		(error) =>
			error.name === 'DevalueError' &&
			error.path === '.array[99999999]' &&
			error.value === value &&
			error.root === root
	);
});

test('ignores non-numeric array properties in dense encoding', () => {
	// Dense path (few holes — array literal / HOLE encoding wins)
	const arr = [, 'a', , 'b'];
	arr.foo = 'should be ignored';
	arr.bar = 42;

	// uneval — should produce the holey literal, no mention of "foo" or "bar"
	const js = uneval(arr);
	expect(!js.includes('foo'), `uneval output should not contain "foo": ${js}`).toBeTruthy();
	expect(!js.includes('bar'), `uneval output should not contain "bar": ${js}`).toBeTruthy();
	expect(
		!js.includes('should be ignored'),
		`uneval output should not contain non-numeric value: ${js}`
	).toBeTruthy();
	const evaled = (0, eval)(js);
	expect(evaled.length).toBe(4);
	expect(evaled[1]).toBe('a');
	expect(evaled[3]).toBe('b');
	expect(!(0 in evaled)).toBeTruthy();

	// stringify — should produce HOLE encoding, no mention of "foo" or "bar"
	const json = stringify(arr);
	expect(!json.includes('foo'), `stringify output should not contain "foo": ${json}`).toBeTruthy();
	expect(!json.includes('bar'), `stringify output should not contain "bar": ${json}`).toBeTruthy();
	const parsed = parse(json);
	expect(parsed.length).toBe(4);
	expect(parsed[1]).toBe('a');
	expect(parsed[3]).toBe('b');
	expect(!(0 in parsed)).toBeTruthy();
});

test.each([{ arr: [1, , 3] }, { arr: [1, ,] }, { arr: [1, , , 4] }, { arr: [1, 2, , 4] }])(
	'uneval round-trips sparse arrays whose first hole is not at index 0 ($arr)',
	({ arr }) => {
		const evaled = (0, eval)(uneval(arr));
		expect(evaled.length, `length for keys ${Object.keys(arr).join(',')}`).toBe(arr.length);
		expect(Object.keys(evaled)).toEqual(Object.keys(arr));
		for (const k of Object.keys(arr)) {
			expect(evaled[k]).toBe(arr[k]);
		}
	}
);

test('ignores non-numeric array properties in sparse encoding', () => {
	// Sparse path (very sparse — Object.assign / SPARSE encoding wins)
	const arr = [];
	arr[1_000_000] = 'x';
	arr.foo = 'should be ignored';
	arr.bar = 42;

	// uneval — should produce Object.assign form, no mention of "foo" or "bar"
	const js = uneval(arr);
	expect(!js.includes('foo'), `uneval output should not contain "foo": ${js}`).toBeTruthy();
	expect(!js.includes('bar'), `uneval output should not contain "bar": ${js}`).toBeTruthy();
	expect(
		!js.includes('should be ignored'),
		`uneval output should not contain non-numeric value: ${js}`
	).toBeTruthy();
	expect(
		js.includes('Object.assign'),
		`uneval should use Object.assign for very sparse arrays`
	).toBeTruthy();
	const evaled = (0, eval)(js);
	expect(evaled.length).toBe(1_000_001);
	expect(evaled[1_000_000]).toBe('x');
	expect(!(0 in evaled)).toBeTruthy();
	expect(!('foo' in evaled)).toBeTruthy();

	// stringify — should produce SPARSE encoding, no mention of "foo" or "bar"
	const json = stringify(arr);
	expect(!json.includes('foo'), `stringify output should not contain "foo": ${json}`).toBeTruthy();
	expect(!json.includes('bar'), `stringify output should not contain "bar": ${json}`).toBeTruthy();
	const parsed = parse(json);
	expect(parsed.length).toBe(1_000_001);
	expect(parsed[1_000_000]).toBe('x');
	expect(!(0 in parsed)).toBeTruthy();
});

test('does not create duplicate parameter names', () => {
	const foo = new Array(20000).fill(0).map((_, i) => i);
	const bar = foo.map((_, i) => ({ [i]: foo[i] }));
	const serialized = uneval([foo, ...bar]);

	eval(serialized);
});

test('reconstructs a referenced typed array before it is used in a cycle', () => {
	const view = new Uint8Array([1, 2, 3]);
	const obj = { a: view, b: view };
	obj.self = obj;

	const result = (0, eval)(uneval(obj));

	expect(result.self).toBe(result);
	expect(result.a instanceof Uint8Array).toBeTruthy();
	expect(result.a).toBe(result.b);
	expect(Array.from(result.a)).toEqual([1, 2, 3]);
});

test('rejects sparse array __proto__ pollution via parse', () => {
	// Attempt to set __proto__ on an array via the sparse array encoding
	const payload = JSON.stringify([[consts.SPARSE, 1, '__proto__', { polluted: true }]]);
	expect(() => parse(payload)).toThrow('Invalid input');
});

test('rejects sparse array __proto__ pollution via unflatten', () => {
	// Same attack via unflatten (which receives already-parsed data)
	const payload = [[consts.SPARSE, 1, '__proto__', { polluted: true }]];
	expect(() => unflatten(payload)).toThrow('Invalid input');
});

test('sparse array CPU exhaustion payload is rejected', () => {
	// Reproduction from reported vulnerability: builds deep __proto__ chains
	// via sparse array encoding, causing expensive [[SetPrototypeOf]] calls.
	const LAYERS = 49_000;
	const data = [[consts.SPARSE, 0], 0, []];
	for (let i = 3; i < 3 + LAYERS; i++) {
		data.push([consts.SPARSE, 0, '__proto__', i - 1]);
		data[0].push('__proto__', i);
	}
	const payload = JSON.stringify(data);

	expect(() => parse(payload)).toThrow('Invalid input');
});

test('sparse array type confusion via __proto__ is blocked', () => {
	// Reproduction from reported vulnerability: uses sparse array encoding to
	// set __proto__ on an array, overwriting the prototype and allowing an
	// attacker to control property values (e.g. spoofing .magnitude on a Vector).
	const payload = `[[${consts.SPARSE},0,"x",1,"y",2,"magnitude",3,"__proto__",4],3,4,"nope",["Vector",5],[6,7],8,9]`;

	class Vector {
		constructor(x, y) {
			this.x = x;
			this.y = y;
		}
		get magnitude() {
			return (this.x ** 2 + this.y ** 2) ** 0.5;
		}
	}

	expect(() => parse(payload, { Vector: ([x, y]) => new Vector(x, y) })).toThrow('Invalid input');
});

test('valid sparse array parses correctly', () => {
	// Ensure the fix does not break legitimate sparse array round-tripping.
	// devalue format: [root_entry, ...other_entries]
	// [-7, 3, 0, 1, 2, 2] = sparse array of length 3, index 0 = entries[1], index 2 = entries[2]
	const goodPayload = JSON.stringify([[consts.SPARSE, 3, 0, 1, 2, 2], 'a', 'c']);
	const result = parse(goodPayload);
	expect(result).toBeInstanceOf(Array);
	expect(result.length).toBe(3);
	expect(result[0]).toBe('a');
	expect(!(1 in result)).toBeTruthy();
	expect(result[2]).toBe('c');
	expect(Object.getPrototypeOf(result)).toBe(Array.prototype);
});

test('errors on out-of-bounds indices', () => {
	expect(() => parse('[["Set",7]]')).toThrow('Invalid input');
});

// Regression test for a DoS vulnerability in sparse array parsing.
// The SPARSE encoding is `[-7, length, idx, val, ...]`. Previously, `parse`
// handled this by calling `new Array(length)`, which V8 eagerly allocates
// a backing store for. A malicious payload containing many such arrays
// — each claiming a huge length but carrying no actual data — could force
// the parser to allocate arbitrarily large amounts of memory and crash
// the host process.
//
// Each case below crafts a payload whose combined implied allocation is
// ~20GB. With a correct fix (lazy allocation / deferred length), every
// case finishes near-instantly. Without it, the test process dies.

/**
 * Builds a payload shaped like:
 *   [ {k0:1, k1:2, ..., k(count-1):count},   // root object, references each sparse array
 *     [-7, perArrayLen, 0, count+1],         // sparse array #0: length = perArrayLen, index 0 -> values[count+1]
 *     [-7, perArrayLen, 0, count+1],         // sparse array #1
 *     ...
 *     42 ]                                   // values[count+1], placed at index 0 of each sparse array
 *
 * Hydrating the root object forces every sparse array to be hydrated,
 * which (without the fix) triggers `new Array(perArrayLen)` `count` times.
 *
 * @param {number} count
 * @param {number} perArrayLen
 */
function buildSparseDoSPayload(count, perArrayLen) {
	let payload = '[{';

	for (let i = 0; i < count; i += 1) {
		if (i > 0) payload += ',';
		payload += `"k${i}":${i + 1}`;
	}

	payload += '}';

	for (let i = 0; i < count; i += 1) {
		payload += `,[${consts.SPARSE},${perArrayLen},0,${count + 1}]`;
	}

	payload += ',42]';
	return payload;
}

// Matrix of (perArrayLen, count) pairs — each row allocates ~2.5e9 slots
// (~20GB assuming 8-byte pointers) if the parser eagerly materializes
// sparse arrays.
const sparseDoSCases = [
	{ perArrayLen: 10_000, count: 250_000 },
	{ perArrayLen: 100_000, count: 25_000 },
	{ perArrayLen: 1_000_000, count: 2_500 },
	{ perArrayLen: 10_000_000, count: 250 },
	{ perArrayLen: 100_000_000, count: 25 }
];

test.each(sparseDoSCases)(
	'does not eagerly allocate sparse arrays (len=$perArrayLen, count=$count)',
	({ perArrayLen, count }) => {
		const payload = buildSparseDoSPayload(count, perArrayLen);
		const result = parse(payload);

		// The root is the object whose keys reference every sparse array;
		// accessing them forces hydration of all `count` arrays.
		expect(typeof result).toBe('object');
		expect(result !== null).toBeTruthy();

		// Spot-check the first and last sparse arrays.
		const first = result.k0;
		const last = result[`k${count - 1}`];
		expect(Array.isArray(first)).toBeTruthy();
		expect(Array.isArray(last)).toBeTruthy();
		expect(first.length).toBe(perArrayLen);
		expect(last.length).toBe(perArrayLen);
		expect(first[0]).toBe(42);
		expect(last[0]).toBe(42);
	}
);

test.each(['inline', 'shared', 'cyclic', 'holes'])(
	'uneval evaluates %s sparse arrays without eager allocation',
	(kind) => {
		// As in the parse regressions above, eager allocation would require ~20GB.
		const length = 1_000_000;
		const arrays = Object.values(parse(buildSparseDoSPayload(2500, length)));
		for (const array of arrays) {
			if (kind === 'holes') {
				delete array[0];
			} else {
				array[1] = kind === 'cyclic' ? array : undefined;
			}
		}

		const js = uneval(kind === 'shared' ? [arrays, arrays.slice()] : arrays);
		const result = (0, eval)(js);
		const restored = kind === 'shared' ? result[0] : result;
		expect(restored.length).toBe(arrays.length);

		for (const i of [0, arrays.length - 1]) {
			const array = restored[i];
			expect(array).toBeInstanceOf(Array);
			expect(array.length).toBe(length);
			expect(Object.getOwnPropertyNames(array)).toStrictEqual(
				kind === 'holes' ? ['length'] : ['0', '1', 'length']
			);
			expect(!(length - 1 in array)).toBeTruthy();
			if (kind !== 'holes') {
				expect(array[0]).toBe(42);
				expect(array[1]).toBe(kind === 'cyclic' ? array : undefined);
			}
			if (kind === 'shared') expect(result[0][i]).toBe(result[1][i]);
		}
	}
);

// --- stringifyAsync tests ---

// Verify same-version wire compatibility and round-trip semantics in one pass
describe.each(Object.entries(fixtures))('stringifyAsync: %s', (_name, tests) => {
	test.each(tests.map((t) => [t.name, t]))('%s', async (_name, t) => {
		const json = await stringifyAsync(t.value, t.reducers);

		expect(json).toEqual(stringify(t.value, t.reducers));
		validate_fixture(t, parse(json, t.revivers));
	});
});

// Async-specific tests
describe('stringifyAsync: promises', () => {
	test('resolves top-level promise', async () => {
		const result = await stringifyAsync(Promise.resolve(42));
		expect(result).toEqual(stringify(42));
	});

	test('resolves promise to undefined', async () => {
		const result = await stringifyAsync(Promise.resolve(undefined));
		expect(result).toEqual(stringify(undefined));
	});

	test('resolves promise to null', async () => {
		const result = await stringifyAsync(Promise.resolve(null));
		expect(result).toEqual(stringify(null));
	});

	test('resolves promise to NaN', async () => {
		const result = await stringifyAsync(Promise.resolve(NaN));
		expect(result).toEqual(stringify(NaN));
	});

	test('resolves nested promises in objects', async () => {
		const result = await stringifyAsync({
			a: Promise.resolve(1),
			b: Promise.resolve('hello')
		});
		expect(result).toEqual(stringify({ a: 1, b: 'hello' }));
	});

	test('resolves promises in arrays', async () => {
		const result = await stringifyAsync([Promise.resolve('a'), Promise.resolve('b')]);
		expect(result).toEqual(stringify(['a', 'b']));
	});

	test('resolves promises in Sets', async () => {
		const result = await stringifyAsync(new Set([Promise.resolve(1), Promise.resolve(2)]));
		expect(result).toEqual(stringify(new Set([1, 2])));
	});

	test('resolves promises in Map values', async () => {
		const result = await stringifyAsync(new Map([['key', Promise.resolve('value')]]));
		expect(result).toEqual(stringify(new Map([['key', 'value']])));
	});

	test('resolves deeply nested promises', async () => {
		const result = await stringifyAsync({
			a: { b: { c: Promise.resolve(42) } }
		});
		expect(result).toEqual(stringify({ a: { b: { c: 42 } } }));
	});

	test('deduplicates resolved values by identity', async () => {
		const obj = { x: 1 };
		const promise = Promise.resolve(obj);
		const result = await stringifyAsync([promise, promise]);
		expect(result).toEqual(stringify([obj, obj]));
	});

	test('handles thenables', async () => {
		const thenable = { then: (resolve) => resolve(42) };
		const result = await stringifyAsync(thenable);
		expect(result).toEqual(stringify(42));
	});

	test('propagates rejected promises', async () => {
		const expected = new Error('fail');
		await expect(stringifyAsync(Promise.reject(expected))).rejects.toBe(expected);
	});

	test('resolves promise to complex value', async () => {
		const complex = { date: new Date(1e12), set: new Set([1, 2]), arr: [3, 4] };
		const result = await stringifyAsync(Promise.resolve(complex));
		expect(result).toEqual(stringify(complex));
	});

	test('resolves mixed sync and async values', async () => {
		const result = await stringifyAsync({
			sync: 'hello',
			async: Promise.resolve('world'),
			nested: {
				sync: 42,
				async: Promise.resolve([1, 2, 3])
			}
		});
		expect(result).toEqual(
			stringify({
				sync: 'hello',
				async: 'world',
				nested: {
					sync: 42,
					async: [1, 2, 3]
				}
			})
		);
	});
});

// Error handling with stringifyAsync
describe('stringifyAsync: errors', () => {
	test('throws for functions', async () => {
		const value = function invalid() {};
		const error = await catch_async_error(() => stringifyAsync(value));
		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify a function');
		expect(error.path).toEqual('');
		expect(error.value).toBe(value);
		expect(error.root).toBe(value);
	});

	test('throws for Symbols', async () => {
		const value = Symbol('foo');
		const error = await catch_async_error(() => stringifyAsync(value));
		expect(error.name).toEqual('DevalueError');
		expect(error.path).toEqual('');
		expect(error.value).toBe(value);
		expect(error.root).toBe(value);
	});

	test('throws for non-POJOs without reducer', async () => {
		class Whatever {}
		const value = new Whatever();
		const error = await catch_async_error(() => stringifyAsync(value));
		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify arbitrary non-POJOs');
		expect(error.path).toEqual('');
		expect(error.value).toBe(value);
		expect(error.root).toBe(value);
	});

	test('throws for promise resolving to function', async () => {
		const value = function invalid() {};
		const root = Promise.resolve(value);
		const error = await catch_async_error(() => stringifyAsync(root));
		expect(error.name).toEqual('DevalueError');
		expect(error.message).toEqual('Cannot stringify a function');
		expect(error.path).toEqual('');
		expect(error.value).toBe(value);
		expect(error.root).toBe(root);
	});
});

describe('circular references through custom types', () => {
	test('resolves circular reference through two custom types', () => {
		const foo = new Foo({ name: 'outer' });
		const bar = new Bar({ name: 'inner', ref: foo });
		foo.value.ref = bar;

		const reducers = {
			Foo: (x) => x instanceof Foo && x.value,
			Bar: (x) => x instanceof Bar && x.value
		};
		const fooCache = new WeakMap();
		const barCache = new WeakMap();
		const revivers = {
			Foo: (x) => {
				let inst = fooCache.get(x);
				if (!inst) {
					inst = Object.create(Foo.prototype);
					fooCache.set(x, inst);
				}
				inst.value = x;
				return inst;
			},
			Bar: (x) => {
				let inst = barCache.get(x);
				if (!inst) {
					inst = Object.create(Bar.prototype);
					barCache.set(x, inst);
				}
				inst.value = x;
				return inst;
			}
		};

		const json = stringify(foo, reducers);
		const result = parse(json, revivers);

		expect(result instanceof Foo).toBeTruthy();
		expect(result.value.ref instanceof Bar).toBeTruthy();
		expect(result.value.ref.value.ref).toBe(result);
	});

	test('resolves self-referencing custom type', () => {
		const foo = new Foo({ name: 'self' });
		foo.value.ref = foo;

		const reducers = {
			Foo: (x) => x instanceof Foo && x.value
		};
		const fooCache = new WeakMap();
		const revivers = {
			Foo: (x) => {
				let inst = fooCache.get(x);
				if (!inst) {
					inst = Object.create(Foo.prototype);
					fooCache.set(x, inst);
				}
				inst.value = x;
				return inst;
			}
		};

		const json = stringify(foo, reducers);
		const result = parse(json, revivers);

		expect(result instanceof Foo).toBeTruthy();
		expect(result.value.ref).toBe(result);
	});
});

{
	describe('uneval: large graphs', () => {
		test('serializes more than 65534 repeated references to valid JS', () => {
			// This graph exceeds engine function-parameter limits that previously
			// made the generated program invalid. See issue #93.
			const shared = Array.from({ length: 70000 }, (_, i) => ({ i }));
			const value = { a: shared, b: shared.slice() };

			const serialized = uneval(value);
			const roundtripped = new Function('return ' + serialized)();

			expect(roundtripped.a.length).toEqual(70000);
			expect(roundtripped.a[0].i).toEqual(0);
			expect(roundtripped.a[69999].i).toEqual(69999);
			// the two arrays share object identity
			expect(roundtripped.a[123] === roundtripped.b[123]).toBeTruthy();
		});

		test('serializes an oversized custom graph to valid JS', () => {
			class Marker {}
			const shared = Array.from({ length: 65536 }, (_, i) => ({ i }));
			const marker = new Marker();
			const value = { a: shared, b: shared.slice(), marker };

			const serialized = uneval(value, (item, js) =>
				item instanceof Marker ? js`({custom:true})` : undefined
			);
			const roundtripped = new Function('return ' + serialized)();

			expect(roundtripped.a[65535]).toBe(roundtripped.b[65535]);
			expect(roundtripped.marker.custom).toBe(true);
		});
	});
}
