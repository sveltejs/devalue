import fs from 'node:fs';
import path from 'node:path';
import { execSync, fork } from 'node:child_process';

/** @type {(command: string) => string} */
const exec = (command) => execSync(command).toString().trim();

const is_jj = execSync('git for-each-ref --count=1 refs/jj/').length > 0;

const current_ref = exec(
	is_jj
		? 'jj show --no-patch --template change_id'
		: 'git symbolic-ref --short -q HEAD || git rev-parse --short HEAD',
);

/** @type {(branch: string) => void} */
const checkout = is_jj
	? (branch) => exec(`jj edit ${branch}`)
	: (branch) => exec(`git checkout ${branch}`);

const runner = path.resolve(import.meta.filename, '../runner.js');
const outdir = path.resolve(import.meta.filename, '../.results');

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir);

/** @type {string[]} */
const branches = [];

for (const arg of process.argv.slice(2)) {
	if (arg.startsWith('--')) continue;
	if (arg === import.meta.filename) continue;

	branches.push(arg);
}

if (branches.length === 0) {
	branches.push(current_ref);
}

if (branches.length === 1) {
	branches.push('main');
}

process.on('exit', () => checkout(current_ref));

for (const branch of branches) {
	console.group(`Benchmarking ${branch}`);

	checkout(branch);

	await new Promise((fulfil, reject) => {
		const child = fork(runner);

		child.on('message', (results) => {
			fs.writeFileSync(`${outdir}/${branch}.json`, JSON.stringify(results, null, '  '));
			fulfil(undefined);
		});

		child.on('error', reject);
	});

	console.groupEnd();
}

const results = branches.map((branch) => {
	return JSON.parse(fs.readFileSync(`${outdir}/${branch}.json`, 'utf-8'));
});

for (let i = 0; i < results[0].length; i += 1) {
	console.group(`${results[0][i].benchmark}`);

	for (const metric of ['time', 'gc_time']) {
		const times = results.map((result) => +result[i][metric]);
		let min = Infinity;
		let max = -Infinity;
		let min_index = -1;

		for (let b = 0; b < times.length; b += 1) {
			const time = times[b];

			if (time < min) {
				min = time;
				min_index = b;
			}

			if (time > max) {
				max = time;
			}
		}

		if (min !== 0) {
			console.group(`${metric}: fastest is ${char(min_index)} (${branches[min_index]})`);
			times.forEach((time, b) => {
				const SIZE = 20;
				const n = Math.round(SIZE * (time / max));

				console.log(
					`${char(b)}: ${'◼'.repeat(n)}${' '.repeat(SIZE - n)} ${time.toFixed(2)}ms`,
				);
			});
			console.groupEnd();
		}
	}

	console.groupEnd();
}

function char(i) {
	return String.fromCharCode(97 + i);
}
