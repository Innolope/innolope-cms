import { execSync } from 'node:child_process'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Identity of this build, baked into the bundle AND emitted as /version.json.
 * A long-lived SPA tab compares the two to learn a newer build was deployed
 * (its in-memory bundle never refreshes on its own). Git SHA when available;
 * in contexts without .git (the cloud Docker build) a timestamp — equality is
 * all that's compared, so any id that changes per build works.
 */
const buildId = (() => {
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim()
	} catch {
		return `t${Date.now()}`
	}
})()

/** Emit /version.json carrying the same build id the bundle was compiled with. */
const emitVersionJson = (): Plugin => ({
	name: 'emit-version-json',
	apply: 'build',
	generateBundle() {
		this.emitFile({
			type: 'asset',
			fileName: 'version.json',
			source: JSON.stringify({ buildId }),
		})
	},
})

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '')
	// Dev API proxy target. Defaults to the local API; override with VITE_DEV_API_PROXY
	// to point at a remote environment.
	const apiTarget = env.VITE_DEV_API_PROXY || 'http://localhost:3001'

	return {
		plugins: [TanStackRouterVite(), react(), tailwindcss(), emitVersionJson()],
		define: {
			__BUILD_ID__: JSON.stringify(buildId),
		},
		server: {
			port: 5173,
			proxy: {
				'/api': {
					target: apiTarget,
					changeOrigin: true,
					secure: !apiTarget.includes('localhost'),
				},
				// Locally-stored media (`/uploads/...`) is served by the API.
				'/uploads': {
					target: apiTarget,
					changeOrigin: true,
					secure: !apiTarget.includes('localhost'),
				},
			},
		},
	}
})
