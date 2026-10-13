import { execFileSync } from 'node:child_process';

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
				await (${fixture})({ assert, vm, turn, delay, parse, stringify, stringifyAsync, unevalStream, data: ${JSON.stringify(data)} });
			`
		],
		{ timeout: 5000, stdio: 'pipe' }
	);
}
