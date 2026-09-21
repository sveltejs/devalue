import { stringify } from '../../src/index.js';
import { records } from '../records.js';
import { fastest_test } from '../utils.js';

/**
 * @param {string} label
 * @param {any} value
 * @param {number} iterations
 */
function benchmark(label, value, iterations) {
	return {
		label: `stringify: ${label}`,
		async fn() {
			for (let i = 0; i < iterations; i += 1) stringify(value);
			return fastest_test(3, () => {
				for (let i = 0; i < iterations; i += 1) stringify(value);
			});
		}
	};
}

const sparse = [];
sparse[1000000] = records(1);

export default [
	benchmark('small object', { id: 42, name: 'Jane Smith', roles: ['admin', 'editor'] }, 100000),
	benchmark('100 records', records(100), 500),
	benchmark('1000 records', records(1000), 50),
	benchmark(
		'unique short strings',
		Array.from({ length: 1000 }, (_, i) => `item-${i}`),
		2000
	),
	benchmark(
		'unique long strings',
		Array.from({ length: 1000 }, (_, i) => `item-${i}:`.padEnd(256, 'x')),
		200
	),
	benchmark(
		'strings with an emoji',
		Array.from({ length: 1000 }, (_, i) => `item-${i} 😀`),
		2000
	),
	benchmark(
		'emoji-dense strings',
		Array.from({ length: 1000 }, (_, i) => `${i} ${'😀❤️'.repeat(20)}`),
		500
	),
	benchmark(
		'escaped strings',
		Array.from({ length: 1000 }, (_, i) => `<p class="item">Item ${i}</p>\n`),
		500
	),
	benchmark(
		'string Map',
		new Map(Array.from({ length: 1000 }, (_, i) => [`key-${i}`, `value-${i}`])),
		500
	),
	benchmark(
		'1000 numbers',
		Array.from({ length: 1000 }, (_, i) => i / 7),
		1000
	),
	benchmark('sparse array', sparse, 20000)
];
