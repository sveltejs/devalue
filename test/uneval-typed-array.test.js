import { describe, expect, test } from 'vitest';
import { uneval } from '../index.js';

describe.each([
	{ TypedArray: Int16Array },
	{ TypedArray: Uint16Array },
	{ TypedArray: Int32Array },
	{ TypedArray: Uint32Array },
	{ TypedArray: Float32Array },
	{ TypedArray: Float64Array },
	{ TypedArray: BigInt64Array },
	{ TypedArray: BigUint64Array }
])('$TypedArray.name', ({ TypedArray }) => {
	describe.each([0, 1])('offset=%s', (offset) => {
		test.each([false, true])('partial trailing element (shared=%s)', (shared) => {
			const size = TypedArray.BYTES_PER_ELEMENT;
			const buffer = new ArrayBuffer(3 * size + 1);
			new Uint8Array(buffer).fill(17);
			const view = new TypedArray(buffer, offset * size, 2);
			const input = shared ? { view, buffer, again: view } : view;
			const result = (0, eval)(uneval(input));
			const revived = shared ? result.view : result;

			expect(revived).toEqual(view);
			expect(revived.byteOffset).toBe(view.byteOffset);
			expect(revived.buffer.byteLength).toBe(buffer.byteLength);
			expect(new Uint8Array(revived.buffer)).toEqual(new Uint8Array(buffer));
			if (shared) {
				expect(revived).toBe(result.again);
				expect(revived.buffer).toBe(result.buffer);
			}
		});
	});
});
