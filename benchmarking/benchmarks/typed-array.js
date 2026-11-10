import { fastest_test } from '../utils.js';

import { parse, stringify } from '../../index.js';

const value_small = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const value_medium = new Uint8Array(Array.from({ length: 10 * 1024 }, (_, i) => i % 256));
const value_large = new Uint8Array(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256));

const string_small = stringify(value_small);
const string_medium = stringify(value_medium);
const string_large = stringify(value_large);

export default [
	{
		label: `stringify: small`,
		async fn() {
			const value = value_small;

			// warm up
			for (let i = 0; i < 10_000; i++) {
				stringify(value);
			}

			return await fastest_test(3, () => {
				for (let i = 0; i < 500_000; i++) {
					stringify(value);
				}
			});
		}
	},

	{
		label: `stringify: medium`,
		async fn() {
			const value = value_medium;

			// warm up
			for (let i = 0; i < 1_000; i++) {
				stringify(value);
			}

			return await fastest_test(3, () => {
				for (let i = 0; i < 5_000; i++) {
					stringify(value);
				}
			});
		}
	},

	{
		label: `stringify: large`,
		async fn() {
			const value = value_large;

			// warm up
			for (let i = 0; i < 10; i++) {
				stringify(value);
			}

			return await fastest_test(3, () => {
				for (let i = 0; i < 50; i++) {
					stringify(value);
				}
			});
		}
	},

	{
		label: `parse: small`,
		async fn() {
			const string = string_small;

			// warm up
			for (let i = 0; i < 10_000; i++) {
				parse(string);
			}

			return await fastest_test(3, () => {
				for (let i = 0; i < 500_000; i++) {
					parse(string);
				}
			});
		}
	},

	{
		label: `parse: medium`,
		async fn() {
			const string = string_medium;

			// warm up
			for (let i = 0; i < 1_000; i++) {
				parse(string);
			}

			return await fastest_test(3, () => {
				for (let i = 0; i < 5_000; i++) {
					parse(string);
				}
			});
		}
	},

	{
		label: `parse: large`,
		async fn() {
			const string = string_large;

			// warm up
			for (let i = 0; i < 10; i++) {
				parse(string);
			}

			return await fastest_test(3, () => {
				for (let i = 0; i < 50; i++) {
					parse(string);
				}
			});
		}
	}
];
