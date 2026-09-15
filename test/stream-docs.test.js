import { readFileSync } from 'node:fs';
import { describe, test, expect } from 'vitest';
import { unevalStream } from '../index.js';

describe('unevalStream documentation', () => {

	function deferred() {
		let resolve;
		const promise = new Promise((fulfil) => {
			resolve = fulfil;
		});
		return { promise, resolve };
	}

	test('the documented concatenation form evaluates real tail statements before returning the root', async () => {
		const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
		expect(readme.includes('const root = new Function(`const root=(${head});${blocks.join(\'\')};return root`)();')).toBeTruthy();

		const later = deferred();
		const { head, tail } = await unevalStream({ quick: 'data', slow: later.promise }, undefined, { id: 'docs-concatenation' });
		later.resolve('arrived after head');
		const blocks = [];
		for await (const block of tail) blocks.push(block);
		expect(blocks.length > 0).toBeTruthy();

		const root = new Function(`const root=(${head});${blocks.join('')};return root`)();
		expect(root.quick).toBe('data');
		expect(await root.slow).toBe('arrived after head');
	});

});
