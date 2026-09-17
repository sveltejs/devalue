import * as vm from 'node:vm';
import * as assert from 'uvu/assert';
import { suite } from 'uvu';
import { uneval } from '../index.js';

const test = suite('uneval: collection construction order');

function ordering_cases() {
	const cases = [];
	for (const kind of ['map value', 'map key', 'set']) {
		for (const position of ['first', 'middle', 'last']) {
			for (const root_kind of ['wrapper', 'container', 'shared wrapper', 'shared container']) {
				cases.push([
					`${kind}: ${position}, ${root_kind}`,
					() => {
						class Wrapper {
							static calls = 0;
							constructor(container) {
								Wrapper.calls += 1;
								this.container = container;
								this.prefix = Array.from(container, (entry) =>
									kind === 'set' ? entry : Array.from(entry)
								);
							}
						}

						const container = kind === 'set' ? new Set() : new Map();
						const add = (key, value) =>
							kind === 'set' ? container.add(value) : container.set(key, value);
						if (position !== 'first') {
							add('before', 42);
							add('also before', 43);
						}
						const wrapper = new Wrapper(container);
						const expected_prefix = wrapper.prefix;
						add(kind === 'map key' ? wrapper : 'wrapper', kind === 'map key' ? 'owner' : wrapper);
						if (position !== 'last') {
							add('after', 44);
							add('also after', 45);
						}
						const root =
							root_kind === 'wrapper'
								? wrapper
								: root_kind === 'container'
									? container
									: root_kind === 'shared wrapper'
										? [wrapper, wrapper, container]
										: [container, wrapper, wrapper];
						let replacer_calls = 0;
						const source = uneval(root, (value, js) => {
							if (value instanceof Wrapper) {
								replacer_calls += 1;
								return js`new Wrapper(${value.container})`;
							}
						});
						Wrapper.calls = 0;
						const result = vm.runInNewContext(`(${source})`, { Wrapper });
						const get_wrapper = (collection) =>
							kind === 'set'
								? Array.from(collection).find((value) => value instanceof Wrapper)
								: kind === 'map key'
									? Array.from(collection.keys()).find((value) => value instanceof Wrapper)
									: collection.get('wrapper');
						const revived =
							root_kind === 'wrapper'
								? result
								: root_kind === 'container'
									? get_wrapper(result)
									: result[root_kind === 'shared wrapper' ? 0 : 1];
						assert.is(Wrapper.calls, 1);
						assert.is(replacer_calls, 1);
						assert.equal(revived.prefix, expected_prefix);
						assert.is(get_wrapper(revived.container), revived);
						const replace = (value) => (value === wrapper ? revived : value);
						assert.equal(
							Array.from(revived.container, (entry) =>
								kind === 'set' ? entry : Array.from(entry)
							),
							Array.from(container, (entry) =>
								kind === 'set' ? replace(entry) : entry.map(replace)
							)
						);
						if (root_kind === 'container') assert.is(revived.container, result);
						if (root_kind === 'shared wrapper') {
							assert.is(result[0], result[1]);
							assert.is(revived.container, result[2]);
						}
						if (root_kind === 'shared container') {
							assert.is(result[1], result[2]);
							assert.is(revived.container, result[0]);
						}
					}
				]);
			}
		}
	}
	return cases;
}

for (const [name, run] of ordering_cases()) test(name, run);

test('initializes the ready prefix and chains entries between constructors', () => {
	class Wrapper {
		constructor(container) {
			this.container = container;
			this.size = container.size;
		}
	}
	for (const kind of ['Map', 'Set']) {
		const container =
			kind === 'Map'
				? new Map([
						[1, 1],
						[2, 2]
					])
				: new Set([1, 2]);
		const wrapper = new Wrapper(container);
		if (kind === 'Map') container.set(3, wrapper).set(4, 4).set(5, 5);
		else container.add(wrapper).add(4).add(5);
		const second = new Wrapper(container);
		if (kind === 'Map') container.set(6, second).set(7, 7).set(8, 8);
		else container.add(second).add(7).add(8);
		const source = uneval([container, wrapper, second], (value, js) =>
			value instanceof Wrapper ? js`new Wrapper(${value.container})` : undefined
		);
		const result = vm.runInNewContext(source, { Wrapper });
		assert.is(result[1].size, 2);
		assert.is(result[1].container, result[0]);
		assert.is(result[2].size, 5);
		assert.is(result[2].container, result[0]);
		assert.is(result[0].size, 8);
		assert.match(
			source,
			kind === 'Map'
				? /let ([\w$]+)=new Map\(\[\[1,1\],\[2,2\]\]\);let ([\w$]+)=new Wrapper\(\1\);\1\.set\(3,\2\)\.set\(4,4\)\.set\(5,5\);let ([\w$]+)=new Wrapper\(\1\);\1\.set\(6,\3\)\.set\(7,7\)\.set\(8,8\)/
				: /let ([\w$]+)=new Set\(\[1,2\]\);let ([\w$]+)=new Wrapper\(\1\);\1\.add\(\2\)\.add\(4\)\.add\(5\);let ([\w$]+)=new Wrapper\(\1\);\1\.add\(\3\)\.add\(7\)\.add\(8\)/
		);
	}
});

test('constructs a complete shared collection from its buffered entries', () => {
	for (const kind of ['Map', 'Set']) {
		const shared = { answer: 42 };
		const container =
			kind === 'Map'
				? new Map([
						[shared, shared],
						[42, 43]
					])
				: new Set([shared, 42]);
		const source = uneval([container, container, shared]);
		const [first, second, value] = vm.runInNewContext(source);
		assert.is(first, second);
		assert.is(first.size, 2);
		assert.is(value.answer, 42);
		if (kind === 'Map') {
			assert.equal(Array.from(first.keys()), [value, 42]);
			assert.is(first.get(value), value);
			assert.is(first.get(42), 43);
		} else {
			assert.equal(Array.from(first), [value, 42]);
		}
		assert.match(source, new RegExp(`new ${kind}\\(\\[`));
		assert.not.match(source, /\.(set|add)\(/);
	}
});

test('populates both cyclic dependencies before constructing their shared owner', () => {
	class Wrapper {
		constructor(left, right) {
			this.left = left;
			this.right = right;
			this.answer = left.get('data').view[0] + right.values().next().value.answer;
		}
	}
	for (const start of ['wrapper', 'map', 'set']) {
		const view = new Uint8Array([20]);
		const data = { answer: 22, view };
		const left = new Map([['data', data]]);
		const right = new Set([data]);
		const wrapper = new Wrapper(left, right);
		left.set('owner', wrapper).set('tail', 1);
		right.add(wrapper).add(2);
		const first = start === 'wrapper' ? wrapper : start === 'map' ? left : right;
		const source = uneval([first, wrapper, left, right, data, view, view.buffer], (value, js) =>
			value instanceof Wrapper ? js`new Wrapper(${value.left},${value.right})` : undefined
		);
		const [, revived, map, set, shared, typed, buffer] = vm.runInNewContext(source, { Wrapper });
		assert.is(revived.answer, 42);
		assert.is(revived.left, map);
		assert.is(revived.right, set);
		assert.is(map.get('owner'), revived);
		assert.equal(Array.from(set), [shared, revived, 2]);
		assert.equal(Array.from(map.keys()), ['data', 'owner', 'tail']);
		assert.is(map.get('data'), shared);
		assert.is(shared.view, typed);
		assert.is(typed.buffer, buffer);
	}
});

test('constructs dependent custom Map keys and values before inserting the entry', () => {
	class Key {
		constructor(map) {
			this.map = map;
			this.prefix = Array.from(map.keys());
		}
	}
	class Value {
		constructor(map, key) {
			this.map = map;
			this.key = key;
			this.prefix = Array.from(map.keys());
		}
	}
	for (const start of ['key', 'value', 'map']) {
		const map = new Map([['before', 42]]);
		const key = new Key(map);
		const value = new Value(map, key);
		map.set(key, value).set('after', 43);
		const first = start === 'key' ? key : start === 'value' ? value : map;
		const source = uneval([first, map, key, value], (item, js) => {
			if (item instanceof Key) return js`new Key(${item.map})`;
			if (item instanceof Value) return js`new Value(${item.map},${item.key})`;
		});
		const [, revived_map, revived_key, revived_value] = vm.runInNewContext(source, { Key, Value });
		assert.equal(revived_key.prefix, ['before']);
		assert.equal(revived_value.prefix, ['before']);
		assert.is(revived_key.map, revived_map);
		assert.is(revived_value.map, revived_map);
		assert.is(revived_value.key, revived_key);
		assert.is(revived_map.get(revived_key), revived_value);
		assert.equal(Array.from(revived_map.keys()), ['before', revived_key, 'after']);
	}
});

test('preserves ordered prefixes through inline and named mixed containers', () => {
	class Wrapper {
		static calls = 0;
		constructor(options, map) {
			Wrapper.calls += 1;
			this.options = options;
			this.map = map;
			this.answer = map.get('data').answer;
		}
	}
	for (const shared of [false, true]) {
		const data = Object.assign(Object.create(null), { answer: 42 });
		const map = new Map([['data', data]]);
		const list = [, map];
		const options = { list };
		const wrapper = new Wrapper(options, map);
		map.set('owner', wrapper).set('tail', 43);
		const root = shared ? [wrapper, options, list, map, data] : wrapper;
		const source = uneval(root, (value, js) => {
			if (!(value instanceof Wrapper)) return;
			const local = js.identifier();
			return js`(()=>{const ${local}=${value.options};return new Wrapper(${local},${value.map})})()`;
		});
		Wrapper.calls = 0;
		const result = vm.runInNewContext(source, { Wrapper });
		const revived = shared ? result[0] : result;
		const revived_map = revived.options.list[1];
		assert.is(Wrapper.calls, 1);
		assert.is(revived.answer, 42);
		assert.is(revived_map.get('owner'), revived);
		assert.is(revived.map, revived_map);
		assert.equal(Array.from(revived_map.keys()), ['data', 'owner', 'tail']);
		assert.is(Object.getPrototypeOf(revived_map.get('data')), null);
		assert.not.ok(0 in revived.options.list);
		if (shared) {
			assert.is(revived.options, result[1]);
			assert.is(revived.options.list, result[2]);
			assert.is(revived_map, result[3]);
			assert.is(revived_map.get('data'), result[4]);
		}
	}
});

test('does not move entries after the constructor back-reference into its prefix', () => {
	class Wrapper {
		constructor(container) {
			this.container = container;
			this.tail = container.get('tail');
		}
	}
	const container = new Map();
	const wrapper = new Wrapper(container);
	container.set('owner', wrapper).set('tail', 42);
	const source = uneval(wrapper, (value, js) =>
		value instanceof Wrapper ? js`new Wrapper(${value.container})` : undefined
	);
	const result = vm.runInNewContext(source, { Wrapper });
	// The back-reference cannot be inserted until the constructor has returned.
	assert.is(result.tail, undefined);
	assert.equal(Array.from(result.container.keys()), ['owner', 'tail']);
	assert.is(result.container.get('owner'), result);
	assert.is(result.container.get('tail'), 42);
});

test('finishes paths through a multi-container cycle after constructing its owner', () => {
	class Wrapper {
		constructor(options) {
			this.options = options;
			this.cyclic_path = options.list?.[0];
		}
	}
	const map = new Map([['data', 42]]);
	const options = { list: [map] };
	const wrapper = new Wrapper(options);
	map.set('owner', wrapper);
	const source = uneval(wrapper, (value, js) =>
		value instanceof Wrapper ? js`new Wrapper(${value.options})` : undefined
	);
	const result = vm.runInNewContext(source, { Wrapper });
	// As with the previous emitter, only the acyclic prefix is ready at construction.
	assert.is(result.cyclic_path, undefined);
	assert.is(result.options.list[0].get('data'), 42);
	assert.is(result.options.list[0].get('owner'), result);
});

test('does not append a chain to an allocation for an empty collection', () => {
	for (const container of [new Map(), new Set()]) {
		const source = uneval([container, container]);
		const [first, second] = vm.runInNewContext(source);
		assert.is(first, second);
		assert.is(first.size, 0);
		assert.not.match(source, /\.(set|add)\(/);
	}
});

test('breaks chains for nested collection and object initialization', () => {
	class Reader {
		constructor(outer, inner) {
			this.outer = outer;
			this.inner = inner;
			this.prefix = Array.from(outer.keys());
			this.answer = inner.values().next().value.answer;
		}
	}
	const data = { answer: 42 };
	const inner = new Set([data]);
	const outer = new Map([
		['before', 1],
		['also before', 2],
		['inner', inner]
	]);
	const reader = new Reader(outer, inner);
	outer.set('reader', reader).set('after', 3);
	inner.add(reader).add(4);
	const source = uneval([outer, reader, inner, data], (value, js) =>
		value instanceof Reader ? js`new Reader(${value.outer},${value.inner})` : undefined
	);
	const [map, revived, set, shared] = vm.runInNewContext(source, { Reader });
	// The inner Set and its owner form the cycle, so the outer Map's first
	// two entries must be visible even while the 'inner' entry is being built.
	assert.equal(revived.prefix, ['before', 'also before']);
	assert.is(revived.answer, 42);
	assert.is(revived.outer, map);
	assert.is(revived.inner, set);
	assert.is(map.get('inner'), set);
	assert.is(map.get('reader'), revived);
	assert.equal(Array.from(set), [shared, revived, 4]);
	assert.equal(Array.from(map.keys()), ['before', 'also before', 'inner', 'reader', 'after']);
});

test('exposes completed earlier cycles to later constructors', () => {
	class Snapshot {
		constructor(map) {
			this.map = map;
			this.initial_keys = Array.from(map.keys());
		}
	}
	for (const kind of ['self', 'peer']) {
		const map = new Map([['before', 42]]);
		const snapshot = new Snapshot(map);
		map.set(kind, kind === 'self' ? map : new Map([['back', map]]));
		map.set('owner', snapshot);
		const source = uneval(snapshot, (value, js) =>
			value instanceof Snapshot ? js`new Snapshot(${value.map})` : undefined
		);
		const result = vm.runInNewContext(source, { Snapshot });
		// Existing alternative-emitter behavior: the original deferred this earlier
		// cyclic entry. See notes/uneval-ordering.md for the snapshot compatibility gap.
		assert.equal(snapshot.initial_keys, ['before']);
		assert.equal(result.initial_keys, ['before', kind]);
		assert.is(result.map.get('owner'), result);
		assert.is(
			kind === 'self' ? result.map.get('self') : result.map.get('peer').get('back'),
			result.map
		);
	}
});

test.run();
