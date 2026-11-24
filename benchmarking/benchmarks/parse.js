import { parse, stringify } from '../../src/index.js';
import { records } from '../records.js';
import { fastest_test } from '../utils.js';

/**
 * @param {string} label
 * @param {string} serialized
 * @param {number} iterations
 * @param {import('../../src/types.js').ParseOptions} [options]
 */
function benchmark(label, serialized, iterations, options) {
	return {
		label: `parse: ${label}`,
		async fn() {
			for (let i = 0; i < iterations; i += 1) parse(serialized, undefined, options);
			return fastest_test(3, () => {
				for (let i = 0; i < iterations; i += 1) parse(serialized, undefined, options);
			});
		}
	};
}

export default [
	benchmark(
		'small object',
		stringify({ id: 42, name: 'Jane Smith', roles: ['admin', 'editor'] }),
		100000
	),
	benchmark('1000 records', stringify(records(1000)), 50),
	benchmark(
		'1000 records (strict)',
		stringify(records(1000), undefined, { references: false }),
		50,
		{ references: false }
	)
];
