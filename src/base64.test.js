import { describe, test, expect } from 'vitest';
import * as base64 from './base64.js';

const strings = [
	'',
	'a',
	'ab',
	'abc',
	'a\r\nb',
	'\xFF\xFE',
	'\x00',
	'\x00\x00\x00',
	'the quick brown fox etc',
	'é',
	'中文',
	'+/',
	'😎'
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('base64_encode_decode', () => {
	test.each(strings)('%j', (string) => {
		const data = encoder.encode(string);

		const with_buffer = base64.encode_buffer(data);
		const with_legacy = base64.encode_legacy(data);

		expect(with_buffer).toBe(with_legacy);
		expect(decoder.decode(base64.decode_buffer(with_buffer))).toBe(string);
		expect(decoder.decode(base64.decode_legacy(with_legacy))).toBe(string);

		if (typeof Uint8Array.fromBase64 === 'function') {
			const with_native = base64.encode_native(data);
			expect(decoder.decode(base64.decode_native(with_native))).toBe(string);
		}
	});
});
