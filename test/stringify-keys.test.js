import * as uvu from 'uvu';
import * as assert from 'uvu/assert';
import { parse, stringify, stringifyAsync } from '../index.js';

for (const fn of [stringify, stringifyAsync]) {
	uvu.test(`${fn.name} escapes property names`, async () => {
		const object = { plain: 1, 'quote"': 2, 'angle<': 3, 'newline\n': 4 };
		const expected = '[{"plain":1,"quote\\"":2,"angle\\u003C":3,"newline\\n":4},1,2,3,4]';

		// twice, so that the second call is served from the key cache
		assert.is(await fn(object), expected);
		assert.is(await fn(object), expected);
		assert.is(
			await fn(Object.assign(Object.create(null), object)),
			'[["null","plain",1,"quote\\"",2,"angle\\u003C",3,"newline\\n",4],1,2,3,4]'
		);
	});

	uvu.test(`${fn.name} quotes more distinct property names than the key cache holds`, async () => {
		const object = {};
		for (let i = 0; i < 1500; i += 1) {
			object[`key-${i}`] = i;
			object[`quote"${i}`] = i;
		}

		for (let round = 0; round < 2; round += 1) {
			assert.equal(parse(await fn(object)), object);
		}
	});
}

uvu.test.run();
