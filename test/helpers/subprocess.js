import { execFileSync } from 'node:child_process';
import { client_script } from './stream.js';

/**
 * Keep strict unhandled-rejection failures (and explicit GC) out of the Vitest process.
 * Fixtures are stringified, so they must not capture anything from their module.
 * @param {(helpers: any) => unknown} fixture
 * @param {{ expose_gc?: boolean, data?: unknown }} [options]
 */
export function in_subprocess(fixture, { expose_gc = false, data } = {}) {
	execFileSync(
		process.execPath,
		[
			'--unhandled-rejections=strict',
			...(expose_gc ? ['--expose-gc', '--max-old-space-size=128'] : []),
			'--input-type=module',
			'--eval',
			`
				import assert from 'node:assert/strict';
				import vm from 'node:vm';
				import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
				import { parse, stringify, stringifyAsync, unevalStream } from ${JSON.stringify(new URL('../../src/index.js', import.meta.url).href)};
				// Installs the client in a VM context, with a receive that records values by id
				const client = (context) => {
					const received = new Map();
					const done = new Set();
					vm.runInContext(${JSON.stringify(client_script)}, context)({
						receive: (id, value) => received.set(id, value),
						done: (id) => done.add(id)
					});
					return { received, done };
				};
				await (${fixture})({ assert, vm, turn, delay, parse, stringify, stringifyAsync, unevalStream, client, data: ${JSON.stringify(data)} });
			`
		],
		{ timeout: 5000, stdio: 'pipe' }
	);
}
