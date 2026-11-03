import { describe, test, expect } from 'vitest';
import { child, create_captured_graph, discover, roll_back } from './graph.js';
import { DevalueError } from './utils.js';

describe('shared graph', () => {
	const create_test_graph = (root) => create_captured_graph(root, () => false);

	test('records one node per identity', () => {
		const shared = {};
		const root = { first: shared, second: shared };
		root.self = root;
		const graph = create_test_graph(root);
		discover(graph, root);

		expect(graph.nodes.length).toBe(2);
		expect(graph.identities.get(root)).toBe(graph.nodes[0]);
		expect(graph.identities.get(shared)).toBe(graph.nodes[1]);
	});

	test('captures sparse arrays and container order as direct children', () => {
		const key = {};
		const array = Array(5);
		array[3] = key;
		array[4] = 'primitive';
		const map = new Map([[key, array]]);
		const set = new Set([array, key]);
		const root = { map, set };
		const graph = create_test_graph(root);
		discover(graph, root);

		const array_node = graph.identities.get(array);
		const key_node = graph.identities.get(key);
		expect(array_node?.keys).toEqual(['3', '4']);
		expect(array_node?.children).toEqual([key_node, 'primitive']);
		expect(array_node?.data).toBe(5);
		expect(graph.identities.get(map)?.children).toEqual([key_node, array_node]);
		expect(graph.identities.get(set)?.children).toEqual([array_node, key_node]);
	});

	test('applies classifications while graph owns recursive discovery', () => {
		class Box {
			constructor(value) {
				this.value = value;
			}
		}
		const inner = {};
		const root = new Box(inner);
		const graph = create_captured_graph(root, (graph, node, value) => {
			if (!(value instanceof Box)) return false;
			node.kind = 'Box';
			node.children = [child(graph, value.value)];
			return true;
		});
		const node = discover(graph, root);

		expect(node?.kind).toBe('Box');
		expect(node?.children[0]).toBe(graph.identities.get(inner));
		expect(graph.nodes.length).toBe(2);
	});

	test('rolls back appended identities without touching earlier captures', () => {
		const shared = {};
		const graph = create_test_graph(shared);
		discover(graph, shared);
		const value = { shared, extra: {} };
		const mark = graph.nodes.length;
		discover(graph, value);
		expect(graph.nodes.length).toBe(3);
		roll_back(graph, mark);
		expect(graph.nodes.length).toBe(1);
		expect(graph.identities.size).toBe(1);
		expect(graph.identities.has(value)).toBe(false);
		expect(graph.identities.get(shared)).toBe(graph.nodes[0]);
	});

	test('rolls back an entire failed recursive discovery', () => {
		const root = { child: {}, invalid: () => {} };
		const graph = create_test_graph(root);
		let error;
		try {
			discover(graph, root);
		} catch (e) {
			error = e;
		}
		roll_back(graph, 0, error);

		expect(graph.nodes.length).toBe(0);
		expect(graph.unwind.length).toBe(0);
		expect(graph.identities.size).toBe(0);
		expect(error.path).toBe('.invalid');
	});

	test('assembles error paths while unwinding', () => {
		class Whatever {}
		const root = {
			ok: [1, 2],
			foo: { 'string-key': new Map([['key', [null, new Whatever()]]]) }
		};
		const graph = create_test_graph(root);
		let error;
		try {
			discover(graph, root);
		} catch (e) {
			error = e;
		}
		roll_back(graph, 0, error);

		expect(error.name).toBe('DevalueError');
		expect(error.message).toBe('Cannot stringify arbitrary non-POJOs');
		expect(error.path).toBe('.foo["string-key"].get("key")[1]');
		expect(error.root).toBe(root);
		expect(graph.nodes.length).toBe(0);
	});

	test('reports __proto__ keys at the owning object', () => {
		const inner = JSON.parse('{"__proto__":1}');
		const root = { foo: inner };
		const graph = create_test_graph(root);
		let error;
		try {
			discover(graph, root);
		} catch (e) {
			error = e;
		}
		roll_back(graph, 0, error);

		expect(error.message).toBe('Cannot stringify objects with __proto__ keys');
		expect(error.path).toBe('.foo');
		expect(error.value).toBe(inner);
	});

	test('does not mutate external errors or retain their unwind path', () => {
		const preserved = {};
		const graph = create_test_graph(preserved);
		discover(graph, preserved);
		const mark = graph.nodes.length;
		const external_value = {};
		const external_root = {};
		const external = new DevalueError(
			'external failure',
			['.external'],
			external_value,
			external_root
		);
		Object.freeze(external);
		const failed = {};
		Object.defineProperty(failed, 'prop', {
			enumerable: true,
			get() {
				throw external;
			}
		});
		let thrown;
		try {
			discover(graph, failed);
		} catch (error) {
			thrown = error;
		}
		roll_back(graph, mark, thrown);

		expect(thrown).toBe(external);
		expect(external.path).toBe('.external');
		expect(external.value).toBe(external_value);
		expect(external.root).toBe(external_root);
		expect(graph.unwind.length).toBe(0);
		expect(graph.nodes.length).toBe(mark);
		expect(graph.identities.get(preserved)).toBe(graph.nodes[0]);
		expect(graph.identities.has(failed)).toBe(false);

		const invalid = { deep: { bad: () => {} } };
		try {
			discover(graph, invalid);
		} catch (error) {
			thrown = error;
		}
		roll_back(graph, mark, thrown);
		expect(thrown.path).toBe('.deep.bad');
		expect(graph.unwind.length).toBe(0);
		expect(graph.nodes.length).toBe(mark);
	});

	test('clears unwind after a revoked value is thrown', () => {
		const graph = create_test_graph(null);
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		const failed = {};
		Object.defineProperty(failed, 'prop', {
			enumerable: true,
			get() {
				throw proxy;
			}
		});
		let thrown;
		try {
			discover(graph, failed);
		} catch (error) {
			thrown = error;
		}
		roll_back(graph, 0, thrown);
		expect(thrown).toBe(proxy);
		expect(graph.unwind.length).toBe(0);
		expect(graph.nodes.length).toBe(0);
	});

	test('does not claim an error owned by a different graph', () => {
		const first = create_test_graph(null);
		let foreign;
		try {
			discover(first, { original: () => {} });
		} catch (error) {
			foreign = error;
		}
		roll_back(first, 0, foreign);
		expect(foreign.path).toBe('.original');

		const second = create_test_graph(null);
		const failed = {};
		Object.defineProperty(failed, 'foreign', {
			enumerable: true,
			get() {
				throw foreign;
			}
		});
		let thrown;
		try {
			discover(second, failed);
		} catch (error) {
			thrown = error;
		}
		roll_back(second, 0, thrown);
		expect(thrown).toBe(foreign);
		expect(foreign.path).toBe('.original');
		expect(second.unwind.length).toBe(0);
	});
});
