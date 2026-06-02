import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text-summary'],
			exclude: ['src/test/**', 'src/scripts/**', 'src/**/*.test.ts'],
		},
	},
})
