import typedarray from '../benchmarks/typed-array.js';

const results = [];

for (let i = 0; i < typedarray.length; i += 1) {
	const benchmark = typedarray[i];

	process.stderr.write(`Running ${i + 1}/${typedarray.length} ${benchmark.label} `);
	results.push({ benchmark: benchmark.label, ...(await benchmark.fn()) });
	process.stderr.write('\x1b[2K\r');
}

process.send?.(results);
