import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.js', 'test/**/*.test.js'],
					exclude: ['test/stream-performance.test.js'],
					testTimeout: 10_000
				}
			},
			{
				test: {
					name: 'performance',
					environment: 'node',
					include: ['test/stream-performance.test.js'],
					testTimeout: 30_000
				}
			}
		]
	}
});
