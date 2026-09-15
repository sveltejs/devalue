import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.js', 'test/**/*.test.js'],
					exclude: ['test/browser/**'],
					testTimeout: 10_000
				}
			}
		]
	}
});
