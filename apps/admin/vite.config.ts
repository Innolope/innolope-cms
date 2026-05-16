import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '')
	// Dev API proxy target. Defaults to the local API; override with VITE_DEV_API_PROXY
	// to point at a remote environment.
	const apiTarget = env.VITE_DEV_API_PROXY || 'http://localhost:3001'

	return {
		plugins: [TanStackRouterVite(), react(), tailwindcss()],
		server: {
			port: 5173,
			proxy: {
				'/api': {
					target: apiTarget,
					changeOrigin: true,
					secure: !apiTarget.includes('localhost'),
				},
			},
		},
	}
})
