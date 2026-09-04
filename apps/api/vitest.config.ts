import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Integration suites each boot the full app; ensureTables serialises
		// concurrent boots on one advisory lock, so a parallel run can queue
		// several multi-second schema passes behind each other.
		hookTimeout: 60_000,
		coverage: {
			provider: 'v8',
			reporter: ['text-summary'],
			exclude: ['src/test/**', 'src/scripts/**', 'src/**/*.test.ts'],
		},
	},
})
