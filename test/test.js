import * as vm from 'vm';
import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import { uneval, unflatten, parse, stringify } from '../index.js';

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

const node_version = +process.versions.node.split('.')[0];

const fixtures = {
	basics: [
		{
			name: 'number',
			value: 42,
			js: '42',
			json: '[42]'
		},
		{
			name: 'negative number',
			value: -42,
			js: '-42',
			json: '[-42]'
		},
		{
			name: 'negative zero',
			value: -0,
			js: '-0',
			json: '-6'
		},
		{
			name: 'positive decimal',
			value: 0.1,
			js: '.1',
			json: '[0.1]'
		},
		{
			name: 'negative decimal',
			value: -0.1,
			js: '-.1',
			json: '[-0.1]'
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
			name: 'Number',
			value: new Number(42),
			js: 'Object(42)',
			json: '[["Object",42]]'
		},
		{
			name: 'String',
			value: new String('yar'),
			js: 'Object("yar")',
			json: '[["Object","yar"]]'
		},
		{
			name: 'Boolean',
			value: new Boolean(false),
			js: 'Object(false)',
			json: '[["Object",false]]'
		},
		{
			name: 'undefined',
			value: undefined,
			js: 'void 0',
			json: '-1'
		},
		{
			name: 'null',
			value: null,
			js: 'null',
			json: '[null]'
		},
		{
			name: 'NaN',
			value: NaN,
			js: 'NaN',
			json: '-3'
		},
		{
			name: 'Infinity',
			value: Infinity,
			js: 'Infinity',
			json: '-4'
		},
		{
			name: 'RegExp',
			value: /regexp/gim,
			js: 'new RegExp("regexp", "gim")',
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
				assert.ok(isNaN(value.valueOf()));
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
			json: '[[1,-6],0]'
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
			json: '[[-2,1,-2],"b"]'
		},
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
			json: '[["Set",1,2,3],1,2,3]'
		},
		{
			name: 'Map',
			value: new Map([['a', 'b']]),
			js: 'new Map([["a","b"]])',
			json: '[["Map",1,2],"a","b"]'
		},
		{
			name: 'BigInt',
			value: BigInt('1'),
			js: '1n',
			json: '[["BigInt","1"]]'
		},
		{
			name: 'Uint8Array',
			value: new Uint8Array([1, 2, 3]),
			js: 'new Uint8Array([1,2,3])',
			json: '[["Uint8Array",1],["ArrayBuffer","AQID"]]'
		},
		{
			name: 'ArrayBuffer',
			value: new Uint8Array([1, 2, 3]).buffer,
			js: 'new Uint8Array([1,2,3]).buffer',
			json: '[["ArrayBuffer","AQID"]]'
		},
		{
			name: 'URL',
			value: new URL(
				'https://user:password@example.com/<script>/path?foo=bar#hash'
			),
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
			json: '[["Uint16Array",1,1,3],["ArrayBuffer","CgAUAB4AKAA="]]'
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
			js: '"a\uDC00b"',
			json: '["a\uDC00b"]'
		},
		{
			name: 'lone high surrogate',
			value: 'a\uD800b',
			js: '"a\uD800b"',
			json: '["a\uD800b"]'
		},
		{
			name: 'two low surrogates',
			value: 'a\uDC00\uDC00b',
			js: '"a\uDC00\uDC00b"',
			json: '["a\uDC00\uDC00b"]'
		},
		{
			name: 'two high surrogates',
			value: 'a\uD800\uD800b',
			js: '"a\uD800\uD800b"',
			json: '["a\uD800\uD800b"]'
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
			js: '"a\uDC00\uD800b"',
			json: '["a\uDC00\uD800b"]'
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
				js: '(function(a){a.set("self", a);return a}(new Map))',
				json: '[["Map",1,0],"self"]',
				validate: (value) => {
					assert.is(value.get('self'), value);
				}
			};
		})(new Map()),

		((set) => {
			set.add(set);
			set.add(42);
			return {
				name: 'Set (cyclical)',
				value: set,
				js: '(function(a){a.add(a).add(42);return a}(new Set))',
				json: '[["Set",0,1],42]',
				validate: (value) => {
					assert.is(value.size, 2);
					assert.ok(value.has(42));
					assert.ok(value.has(value));
				}
			};
		})(new Set()),

		((arr) => {
			arr[0] = arr;
			return {
				name: 'Array (cyclical)',
				value: arr,
				js: '(function(a){a[0]=a;return a}(Array(1)))',
				json: '[[0]]',
				validate: (value) => {
					assert.is(value.length, 1);
					assert.is(value[0], value);
				}
			};
		})([]),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object (cyclical)',
				value: obj,
				js: '(function(a){a.self=a;return a}({}))',
				json: '[{"self":0}]',
				validate: (value) => {
					assert.is(value.self, value);
				}
			};
		})({}),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype (cyclical)',
				value: obj,
				js: '(function(a){a.self=a;return a}(Object.create(null)))',
				json: '[["null","self",0]]',
				validate: (value) => {
					assert.is(Object.getPrototypeOf(value), null);
					assert.is(value.self, value);
				}
			};
		})(Object.create(null)),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype class',
				value: obj,
				js: '(function(a){a.foo="bar";a.self=a;return a}({}))',
				json: '[{"foo":1,"self":0},"bar"]',
				validate: (value) => {
					assert.is(value.foo, 'bar');
					assert.is(value.self, value);
				}
			};
		})(Object.assign(new NullObject(), { foo: 'bar' })),

		((first, second) => {
			first.second = second;
			second.first = first;
			return {
				name: 'Object (cyclical)',
				value: [first, second],
				js: '(function(a,b){a.second=b;b.first=a;return [a,b]}({},{}))',
				json: '[[1,2],{"second":2},{"first":1}]',
				validate: (value) => {
					assert.is(value[0].second, value[1]);
					assert.is(value[1].first, value[0]);
				}
			};
		})({}, {})
	],

	repetition: [
		{
			name: 'String (repetition)',
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

		((object) => {
			return {
				name: 'Object (repetition)',
				value: [object, object],
				js: '(function(a){return [a,a]}({}))',
				json: '[[1,1],{}]'
			};
		})({}),

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
			js: '(function(a){return [new Uint8Array([a]),new Uint16Array([a])]}(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer))',
			json: '[[1,3],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="],["Uint16Array",2]]',
			validate: ([uint8, uint16]) => {
				return uint8.buffer === uint16.buffer;
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
			js: `new RegExp("[\\u003C/script>\\u003Cscript>alert('xss')//]", "")`,
			json: `[["RegExp","[\\u003C/script>\\u003Cscript>alert('xss')//]"]]`
		}
	],

	misc: [
		{
			name: 'Object without prototype',
			value: Object.create(null),
			js: '{__proto__:null}',
			json: '[["null"]]',
			validate: (value) => {
				assert.equal(Object.getPrototypeOf(value), null);
				assert.equal(Object.keys(value).length, 0);
			}
		},
		{
			name: 'cross-realm POJO',
			value: vm.runInNewContext('({})'),
			js: '{}',
			json: '[{}]',
			validate: (value) => {
				assert.equal(Object.getPrototypeOf(value), Object.prototype);
				assert.equal(Object.keys(value).length, 0);
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
			js: '(function(a){return [a,a]}(new Foo({bar:new Bar({answer:42})})))',
			json: '[[1,1],["Foo",2],{"bar":3},["Bar",4],{"answer":5},42]',
			replacer: (value, uneval) => {
				if (value instanceof Foo) {
					return `new Foo(${uneval(value.value)})`;
				}

				if (value instanceof Bar) {
					return `new Bar(${uneval(value.value)})`;
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
				assert.is(obj1, obj2);
				assert.ok(obj1 instanceof Foo);
				assert.ok(obj1.value.bar instanceof Bar);
				assert.equal(obj1.value.bar.value.answer, 42);
			}
		}
	])(new Foo({ bar: new Bar({ answer: 42 }) })),

	custom_fallback: ((date) => [
		{
			name: 'Custom fallback',
			value: date,
			js: "new Date('')",
			json: '[["Date",""]]',
			replacer: (value) => value instanceof Date && `new Date('')`,
			reducers: {
				Date: (value) => value instanceof Date && '',
			},
			revivers: {
				Date: (value) => new Date(value)
			},
			validate: (obj) => {
				assert.ok(obj instanceof Date);
				assert.ok(isNaN(obj.getDate()));
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
				replacer: (value, uneval) => {
					if (value instanceof FunctionRef) {
						// Serialize the function code directly as a string
						return `new FunctionRef(${value.fn.toString()})`;
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
					assert.ok(result instanceof FunctionRef);
					assert.ok(typeof result.fn === 'function');
					// Test that the function works
					assert.equal(result.fn(5), 10);
				}
			},
			{
				name: 'Function in nested structure',
				value: { fn: testFn, nested: { data: 42 } },
				js: '{fn:(x) => x * 2,nested:{data:42}}',
				json: '[{"fn":1,"nested":3},["FunctionRef",2],"(x) => x * 2",{"data":4},42]',
				replacer: (value, uneval) => {
					if (typeof value === 'function') {
						// Serialize the function code directly
						return value.toString();
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
					assert.ok(typeof result.fn === 'function');
					assert.equal(result.nested.data, 42);
					assert.equal(result.fn(3), 6);
				}
			}
		];
	})()
};

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`uneval: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = uneval(t.value, t.replacer);
			const expected = t.js;
			assert.equal(actual, expected);
		});
	}
	test.run();
}

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`stringify: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = stringify(t.value, t.reducers);
			const expected = t.json;
			assert.equal(actual, expected);
		});
	}
	test.run();
}

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`parse: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = parse(t.json, t.revivers);
			const expected = t.value;

			if (t.validate) {
				t.validate(actual);
			} else {
				assert.equal(actual, expected);
			}
		});
	}
	test.run();
}

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`unflatten: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = unflatten(JSON.parse(t.json), t.revivers);
			const expected = t.value;

			if (t.validate) {
				t.validate(actual);
			} else {
				assert.equal(actual, expected);
			}
		});
	}
	test.run();
}

const invalid = [
	{
		name: 'typed array with non-ArrayBuffer input',
		json: '[["Int8Array", 1], { "length": 2 }, 1000000000]',
		message: 'Invalid input, expected ArrayBuffer but got object'
	},
	{
		name: 'empty string',
		json: '',
		message: 'Unexpected end of JSON input'
	},
	{
		name: 'invalid JSON',
		json: '][',
		message:
			node_version >= 20
				? `Unexpected token ']', "][" is not valid JSON`
				: 'Unexpected token ] in JSON at position 0'
	},
	{
		name: 'hole',
		json: '-2',
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
		name: 'bad index',
		json: '[{"0":1,"toString":"push"},"hello"]',
		message: 'Invalid input'
	}
];

for (const { name, json, message } of invalid) {
	uvu.test(`parse error: ${name}`, () => {
		assert.throws(
			() => parse(json),
			(error) => {
				const match = error.message === message;
				if (!match) {
					console.error(`Expected: ${message}, got: ${error.message}`);
				}
				return match;
			}
		);
	});
}

for (const fn of [uneval, stringify]) {
	uvu.test(`${fn.name} throws for non-POJOs`, () => {
		class Foo {}
		const foo = new Foo();
		assert.throws(() => fn(foo));
	});

	uvu.test(`${fn.name} throws for symbolic keys`, () => {
		assert.throws(() => fn({ [Symbol()]: null }));
	});

	uvu.test(`${fn.name} populates error.keys and error.path`, () => {
		try {
			fn({
				foo: {
					array: [function invalid() {}]
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.path, '.foo.array[0]');
		}

		try {
			class Whatever {}
			fn({
				foo: {
					['string-key']: new Map([['key', new Whatever()]])
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify arbitrary non-POJOs');
			assert.equal(e.path, '.foo["string-key"].get("key")');
		}
	});

	uvu.test(`${fn.name} populates error.path after maps (#64)`, () => {
		try {
			fn({
				map: new Map([['key', 'value']]),
				object: {
					invalid() {}
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.path, '.object.invalid');
		}
	});

	uvu.test(`${fn.name} populates error.value with the problematic value`, () => {
		const testFn = function invalid() {};
		try {
			fn({
				foo: {
					array: [testFn]
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.value, testFn);
		}
	});

	uvu.test(`${fn.name} populates error.root with the root value`, () => {
		const root = {
			foo: {
				array: [function invalid() {}]
			}
		};
		try {
			fn(root);
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.root, root);
		}
	});

	uvu.test(`${fn.name} includes value and root on arbitrary non-POJOs error`, () => {
		class Whatever {}
		const problematicValue = new Whatever();
		const root = {
			foo: {
				['string-key']: new Map([['key', problematicValue]])
			}
		};
		try {
			fn(root);
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify arbitrary non-POJOs');
			assert.equal(e.value, problematicValue);
			assert.equal(e.root, root);
		}
	});

	uvu.test(`${fn.name} includes value and root on symbolic keys error`, () => {
		const symbolKey = Symbol('key');
		const root = { [symbolKey]: 'value' };
		try {
			fn(root);
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify POJOs with symbolic keys');
			assert.equal(e.value, root);
			assert.equal(e.root, root);
		}
	});
}

uvu.test('does not create duplicate parameter names', () => {
	const foo = new Array(20000).fill(0).map((_, i) => i);
	const bar = foo.map((_, i) => ({ [i]: foo[i] }));
	const serialized = uneval([foo, ...bar]);

	eval(serialized);
});

uvu.test.run();
