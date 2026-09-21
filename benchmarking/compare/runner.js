import stringify_benchmarks from '../benchmarks/stringify.js';
import typed_array_benchmarks from '../benchmarks/typed-array.js';
import uneval_benchmarks from '../benchmarks/uneval.js';

const benchmarks = [...stringify_benchmarks, ...typed_array_benchmarks, ...uneval_benchmarks];
const results = [];

for (let i = 0; i < benchmarks.length; i += 1) {
	const benchmark = benchmarks[i];

	process.stderr.write(`Running ${i + 1}/${benchmarks.length} ${benchmark.label} `);
	results.push({ benchmark: benchmark.label, ...(await benchmark.fn()) });
	process.stderr.write('\x1b[2K\r');
}

process.send?.(results);
