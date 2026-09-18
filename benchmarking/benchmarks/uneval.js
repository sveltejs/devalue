import { uneval } from '../../index.js';
import { fastest_test } from '../utils.js';

/** @param {number} length */
function records(length) {
	return Array.from({ length }, (_, i) => ({
		id: i,
		title: `Article number ${i}`,
		slug: `article-number-${i}`,
		description: `A description of article ${i} with representative content for server-rendered data.`,
		status: i % 3 === 0 ? 'draft' : 'published',
		tags: ['news', 'featured'],
		date: new Date(1700000000000 + i * 86400000),
		author: { id: i % 10, name: `Author ${i % 10}` }
	}));
}

/**
 * @param {string} label
 * @param {any} value
 * @param {number} iterations
 */
function benchmark(label, value, iterations) {
	return {
		label: `uneval: ${label}`,
		async fn() {
			for (let i = 0; i < iterations; i += 1) uneval(value);
			return fastest_test(3, () => {
				for (let i = 0; i < iterations; i += 1) uneval(value);
			});
		}
	};
}

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
	benchmark('repeated short strings', Array(1000).fill('pending'), 2000),
	benchmark('repeated long strings', Array(1000).fill('x'.repeat(256)), 200),
	benchmark(
		'string Map',
		new Map(Array.from({ length: 1000 }, (_, i) => [`key-${i}`, `value-${i}`])),
		500
	),
	benchmark('1000 numbers', Array.from({ length: 1000 }, (_, i) => i / 7), 1000),
	benchmark('amplification n=2000', Array(2000).fill('x'.repeat(2000)), 10),
	benchmark('amplification n=4000', Array(4000).fill('x'.repeat(4000)), 3)
];
