import multipart from '@fastify/multipart'
import type { MediaAdapter } from '@innolope/types'
import fp from 'fastify-plugin'
import { LocalFsAdapter } from '../adapters/local-fs.js'

declare module 'fastify' {
	interface FastifyInstance {
		media: MediaAdapter
		videoAdapter: MediaAdapter | null
	}
}

/** Read a required environment variable, failing loudly if the configured adapter needs it. */
function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(`${name} is required for the configured media adapter`)
	}
	return value
}

export const mediaPlugin = fp(async (app) => {
	await app.register(multipart, {
		limits: {
			fileSize: 50 * 1024 * 1024, // 50MB
		},
	})

	// Select adapter based on environment
	const adapterName = process.env.MEDIA_ADAPTER || 'local'
	let adapter: MediaAdapter

	switch (adapterName) {
		case 'cloudflare': {
			const { CloudflareImagesAdapter } = await import('../adapters/cloudflare-images.js')
			adapter = new CloudflareImagesAdapter({
				accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
				apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
				accountHash: requireEnv('CLOUDFLARE_IMAGES_ACCOUNT_HASH'),
			})
			break
		}
		default:
			adapter = new LocalFsAdapter()
	}

	app.decorate('media', adapter)

	// Video adapter (Cloudflare Stream)
	let videoAdapter: MediaAdapter | null = null
	if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
		const { CloudflareStreamAdapter } = await import('../adapters/cloudflare-stream.js')
		videoAdapter = new CloudflareStreamAdapter({
			accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
			apiToken: process.env.CLOUDFLARE_API_TOKEN,
		})
		app.log.info('Video adapter: cloudflare-stream')
	}
	app.decorate('videoAdapter', videoAdapter)

	app.log.info(`Media adapter: ${adapterName}`)
})
