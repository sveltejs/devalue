import { uneval } from '../../src/index.js';
import { records } from '../records.js';
import { fastest_test } from '../utils.js';

/**
 * @param {string} label
 * @param {any} value
 * @param {number} iterations
 * @param {import('../../src/index.js').UnevalReplacer} [replacer]
 */
function benchmark(label, value, iterations, replacer) {
	return {
		label: `uneval: ${label}`,
		async fn() {
			for (let i = 0; i < iterations; i += 1) uneval(value, replacer);
			return fastest_test(3, () => {
				for (let i = 0; i < iterations; i += 1) uneval(value, replacer);
			});
		}
	};
}

/** Rows of strings and numbers only, as a database query might return */
const rows = Array.from({ length: 1000 }, (_, i) => ({
	id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
	name: `Row number ${i}`,
	count: i
}));

const shared = { role: 'admin' };

export default [
	benchmark('small object', { id: 42, name: 'Jane Smith', roles: ['admin', 'editor'] }, 100000),
	benchmark('100 records', records(100), 500),
	benchmark('1000 records', records(1000), 50),
	benchmark('1000 plain rows', { rows }, 100),
	benchmark('1000 plain rows, replacer', { rows }, 100, () => undefined),
	benchmark('1000 plain rows, then a Map', { rows, map: new Map([[1, 2]]) }, 100),
	benchmark(
		'1000 plain rows, then a custom value',
		{ rows, streamed: Promise.resolve(1) },
		100,
		(thing, js) => (thing instanceof Promise ? js`defer(${1})` : undefined)
	),
	benchmark('1000 plain rows, then a repeated reference', [...rows, { shared }, { shared }], 100),
	benchmark(
		'1000 plain rows, then a Map of every row',
		{ rows, by_id: new Map(rows.map((row) => [row.id, row])) },
		50
	),
	benchmark(
		'1000 rows sharing one object',
		rows.map((row) => ({ ...row, shared })),
		100
	),
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
	benchmark('repeated short strings', Array(1000).fill('pending'), 2000),
	benchmark('repeated long strings', Array(1000).fill('x'.repeat(256)), 200),
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
	benchmark('amplification n=2000', Array(2000).fill('x'.repeat(2000)), 10),
	benchmark('amplification n=4000', Array(4000).fill('x'.repeat(4000)), 3)
];
