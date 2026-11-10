import { describe, expect, test } from 'vitest';
import { DevalueError, uneval } from '../src/index.js';

// `uneval` serializes plain data in a single pass and hands over to the general
// algorithm at the first value that pass cannot handle. These tests put such a
// value after, inside and before plain data, so that the handover is exercised.

class Custom {
	/** @param {any} inner */
	constructor(inner) {
		this.inner = inner;
	}
}

/** @type {import('../src/index.js').UnevalReplacer} */
const replace_custom = (value, js) => {
	if (value instanceof Custom) return js`new Custom(${value.inner})`;
};

/**
 * @param {string} source
 * @returns {any}
 */
const run = (source) => new Function('Custom', `return ${source}`)(Custom);

/**
 * @param {() => any} fn
 * @returns {any}
 */
function capture(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected an error');
}

describe('uneval: handover from the single-pass serializer', () => {
	describe.each([
		{ name: 'Map', make: () => new Map([[1, { a: 1 }]]), js: 'new Map([[1,{a:1}]])' },
		{ name: 'Set', make: () => new Set([1, 'a']), js: 'new Set([1,"a"])' },
		{ name: 'RegExp', make: () => /a/g, js: 'new RegExp("a","g")' },
		{ name: 'BigInt', make: () => 1n, js: '1n' },
		{
			name: 'URL',
			make: () => new URL('https://example.com/'),
			js: 'new URL("https://example.com/")'
		},
		{ name: 'boxed number', make: () => Object(1), js: 'Object(1)' },
		{ name: 'null-prototype object', make: () => Object.create(null), js: '{__proto__:null}' },
		{ name: 'typed array', make: () => new Uint8Array([1, 2]), js: 'new Uint8Array([1,2])' },
		{ name: 'sparse array', make: () => [1, , 3], js: '[1,,3]' },
		{ name: 'custom', make: () => new Custom({ a: [1] }), js: 'new Custom({a:[1]})' }
	])('$name', ({ make, js }) => {
		test.each([
			{
				position: 'after plain data',
				wrap: (/** @type {any} */ value) => ({ rows: [{ id: 1 }, { id: 2 }], value }),
				expected: `{rows:[{id:1},{id:2}],value:${js}}`
			},
			{
				position: 'between plain data',
				wrap: (/** @type {any} */ value) => ({ before: [{ id: 1 }], value, after: { 'a-b': [2] } }),
				expected: `{before:[{id:1}],value:${js},after:{"a-b":[2]}}`
			},
			{
				position: 'nested inside plain data',
				wrap: (/** @type {any} */ value) => [{ id: 1 }, [0, { value, id: 2 }, 'x'], { id: 3 }],
				expected: `[{id:1},[0,{value:${js},id:2},"x"],{id:3}]`
			},
			{
				position: 'before plain data',
				wrap: (/** @type {any} */ value) => [value, { id: 1 }],
				expected: `[${js},{id:1}]`
			}
		])('$position', ({ wrap, expected }) => {
			expect(uneval(wrap(make()), replace_custom)).toBe(expected);
		});
	});

	test.each([
		{
			name: 'function',
			make: () => () => {},
			message: 'Cannot stringify a function',
			path: '.rows[1].value'
		},
		{
			name: 'symbol',
			make: () => Symbol('x'),
			message: 'Cannot stringify a Symbol primitive',
			path: '.rows[1].value'
		},
		{
			name: 'class instance',
			make: () => new (class Foo {})(),
			message: 'Cannot stringify arbitrary non-POJOs',
			path: '.rows[1].value'
		},
		{
			name: 'object with a symbolic key',
			make: () => ({ [Symbol('x')]: 1 }),
			message: 'Cannot stringify POJOs with symbolic keys',
			path: '.rows[1].value'
		},
		{
			name: 'object with a __proto__ key',
			make: () => JSON.parse('{"a":{"b":1},"__proto__":2}'),
			message: 'Cannot stringify objects with __proto__ keys',
			path: '.rows[1].value'
		}
	])('reports the path to a $name that follows plain data', ({ make, message, path }) => {
		const invalid = make();
		const root = { rows: [{ id: 1 }, { id: 2, value: invalid, after: [3] }] };
		const error = capture(() => uneval(root));

		expect(error).toBeInstanceOf(DevalueError);
		expect(error.message).toMatch(message);
		expect(error.path).toBe(path);
		expect(error.value).toBe(invalid);
		expect(error.root).toBe(root);
	});

	test.each([
		{ name: 'in the middle', make: () => [{ id: 1 }, , { id: 2 }], js: '[{id:1},,{id:2}]' },
		{ name: 'at the start', make: () => [, { id: 1 }], js: '[,{id:1}]' },
		{ name: 'at the end', make: () => [{ id: 1 }, ,], js: '[{id:1},,]' },
		{
			name: 'after a value that needs the general algorithm',
			make: () => [{ id: 1 }, new Set(), , 2],
			js: '[{id:1},new Set([]),,2]'
		},
		{ name: 'beside undefined', make: () => [undefined, , undefined], js: '[void 0,,void 0]' }
	])('serializes an array with a hole $name', ({ make, js }) => {
		expect(uneval({ rows: [[1, 2]], sparse: make() })).toBe(`{rows:[[1,2]],sparse:${js}}`);
	});

	test('serializes a very sparse array that follows plain data', () => {
		const sparse = [{ id: 1 }];
		sparse[1000000] = { id: 2 };
		const result = run(uneval({ rows: [{ id: 0 }], sparse }));

		expect(result.rows).toEqual([{ id: 0 }]);
		expect(result.sparse.length).toBe(1000001);
		expect(Object.keys(result.sparse)).toEqual(['0', '1000000']);
		expect(result.sparse[1000000]).toEqual({ id: 2 });
	});

	test.each([
		{
			name: 'an earlier sibling',
			make: () => {
				const shared = { id: 1 };
				return { rows: [shared, { id: 2 }], again: shared };
			},
			check: (/** @type {any} */ result) => expect(result.again).toBe(result.rows[0])
		},
		{
			name: 'two later siblings',
			make: () => {
				const shared = { role: 'admin' };
				return [{ id: 1 }, { id: 2 }, { shared }, { shared }];
			},
			check: (/** @type {any} */ result) => expect(result[2].shared).toBe(result[3].shared)
		},
		{
			name: 'an ancestor',
			make: () => {
				/** @type {any} */
				const root = { rows: [{ id: 1 }, { id: 2 }] };
				root.rows[1].root = root;
				return root;
			},
			check: (/** @type {any} */ result) => expect(result.rows[1].root).toBe(result)
		},
		{
			name: 'a plain object from inside a Map',
			make: () => {
				const shared = { id: 1 };
				return { rows: [shared, { id: 2 }], map: new Map([['shared', shared]]) };
			},
			check: (/** @type {any} */ result) => expect(result.map.get('shared')).toBe(result.rows[0])
		},
		{
			name: 'a plain object from a custom value',
			make: () => {
				const shared = { id: 1 };
				return { rows: [shared, { id: 2 }], custom: new Custom(shared) };
			},
			check: (/** @type {any} */ result) => expect(result.custom.inner).toBe(result.rows[0])
		},
		{
			name: 'the root from a custom value',
			make: () => {
				/** @type {any} */
				const root = { rows: [{ id: 1 }, { id: 2 }] };
				root.custom = new Custom(root);
				return root;
			},
			check: (/** @type {any} */ result) => expect(result.custom.inner).toBe(result)
		}
	])('preserves a reference to $name', ({ make, check }) => {
		const value = make();
		const result = run(uneval(value, replace_custom));

		expect(result).toEqual(value);
		check(result);
	});

	test('hoists a long string that is repeated after plain data', () => {
		const long = 'x'.repeat(128);
		const source = uneval({ rows: [{ id: 1, long }, { id: 2 }], again: long });

		expect(source.split(long).length - 1).toBe(1);
		expect(run(source)).toEqual({ rows: [{ id: 1, long }, { id: 2 }], again: long });
	});

	test('does not hoist distinct long strings or repeated short ones', () => {
		const short = 'x'.repeat(127);
		const value = [{ a: 'a'.repeat(128) }, { a: 'b'.repeat(128) }, short, short, new Set()];

		expect(uneval(value)).toBe(
			`[{a:"${'a'.repeat(128)}"},{a:"${'b'.repeat(128)}"},"${short}","${short}",new Set([])]`
		);
	});

	describe('replacer', () => {
		/**
		 * @param {any} value
		 * @param {import('../src/index.js').UnevalReplacer} [replacer]
		 */
		function replaced(value, replacer = replace_custom) {
			/** @type {any[]} */
			const calls = [];
			const source = uneval(value, (thing, js) => {
				calls.push(thing);
				return replacer(thing, js);
			});
			return { calls, source };
		}

		test('is called once per object, in order, when the value is plain', () => {
			const a = { id: 1 };
			const b = { id: 2, tags: ['x'] };
			const root = { rows: [a, b], at: new Date(0) };

			expect(replaced(root).calls).toEqual([root, root.rows, a, b, b.tags, root.at]);
		});

		test('is called once per object, in order, when a custom value follows plain data', () => {
			const a = { id: 1 };
			const b = { id: 2 };
			const inner = { c: [3] };
			const root = { rows: [a, b], custom: new Custom(inner), after: { d: 4 } };
			const { calls, source } = replaced(root);

			expect(calls).toEqual([root, root.rows, a, b, root.custom, inner, inner.c, root.after]);
			expect(source).toBe('{rows:[{id:1},{id:2}],custom:new Custom({c:[3]}),after:{d:4}}');
		});

		test('is called once per object when a reference is repeated after plain data', () => {
			const a = { id: 1 };
			const b = { id: 2 };
			const root = { rows: [a, b], again: a, map: new Map([[b, a]]) };

			expect(replaced(root).calls).toEqual([root, root.rows, a, b, root.map]);
		});

		test('is called once per object before an error', () => {
			const a = { id: 1 };
			const invalid = () => {};
			const root = { rows: [a], invalid };
			/** @type {any[]} */
			const calls = [];

			expect(() => uneval(root, (thing) => void calls.push(thing))).toThrow(
				'Cannot stringify a function'
			);
			expect(calls).toEqual([root, root.rows, a, invalid]);
		});

		test('can replace a plain object in the middle of plain data', () => {
			const { calls, source } = replaced(
				{ rows: [{ id: 1 }, { id: 2, wrap: true }, { id: 3 }] },
				(thing, js) => (thing.wrap ? js`wrap(${thing.id})` : undefined)
			);

			expect(source).toBe('{rows:[{id:1},wrap(2),{id:3}]}');
			expect(calls.length).toBe(5);
		});

		test('can replace a promise that follows plain data', () => {
			const streamed = Promise.resolve(1);
			let id = 0;
			const source = uneval(
				{ type: 'data', data: { rows: [{ id: 1 }, { id: 2 }], streamed }, uses: undefined },
				(thing, js) => (typeof thing?.then === 'function' ? js`defer(${++id})` : undefined)
			);

			expect(source).toBe(
				'{type:"data",data:{rows:[{id:1},{id:2}],streamed:defer(1)},uses:void 0}'
			);
		});

		test.each([
			{ result: 0, message: 'Invalid uneval replacer result' },
			{ result: 'nope', message: 'Invalid JavaScript fragment' }
		])('rejects $result returned for an object that follows plain data', ({ result, message }) => {
			expect(() =>
				uneval(
					{ rows: [{ id: 1 }], last: { id: 2 } },
					(thing) => /** @type {any} */ (thing.id === 2 ? result : undefined)
				)
			).toThrow(message);
		});
	});
});
