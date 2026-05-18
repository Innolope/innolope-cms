import multipart from '@fastify/multipart'
import type { ProjectSettings } from '@innolope/db'
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

/** The configured media adapter name (`MEDIA_ADAPTER` env, default `local`). */
export function mediaAdapterName(): string {
	return process.env.MEDIA_ADAPTER || 'local'
}

/** Build the media storage adapter from environment configuration. */
export async function createMediaAdapter(): Promise<MediaAdapter> {
	switch (mediaAdapterName()) {
		case 'cloudflare': {
			const { CloudflareImagesAdapter } = await import('../adapters/cloudflare-images.js')
			return new CloudflareImagesAdapter({
				accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
				apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
				accountHash: requireEnv('CLOUDFLARE_IMAGES_ACCOUNT_HASH'),
			})
		}
		default:
			return new LocalFsAdapter()
	}
}

/** Raised when a project's chosen media adapter is missing required credentials. */
export class MediaConfigError extends Error {}

/**
 * A non-`local` `MEDIA_ADAPTER` env var is a global operator override. `local` (the
 * deploy default written by tooling) and an unset value both mean "no override" — the
 * project's own `settings.mediaAdapter` decides.
 */
function envAdapterOverride(): string | undefined {
	const env = process.env.MEDIA_ADAPTER
	return env && env !== 'local' ? env : undefined
}

/**
 * Build the media adapter for a single project.
 *
 * The project's `settings.mediaAdapter` decides, unless a non-`local` `MEDIA_ADAPTER`
 * env var forces a global override. Cloudflare credentials come from the project
 * settings first, falling back to the server-level `CLOUDFLARE_*` env vars.
 */
export async function resolveMediaAdapter(
	settings: ProjectSettings | undefined,
): Promise<MediaAdapter> {
	const name = envAdapterOverride() || settings?.mediaAdapter || 'local'

	if (name === 'cloudflare') {
		const cf = settings?.cloudflare ?? {}
		const accountId = cf.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
		const apiToken = cf.apiToken || process.env.CLOUDFLARE_API_TOKEN
		const accountHash = cf.imagesAccountHash || process.env.CLOUDFLARE_IMAGES_ACCOUNT_HASH
		if (!accountId || !apiToken || !accountHash) {
			throw new MediaConfigError(
				'Cloudflare Images is selected for this project but credentials are incomplete. ' +
					'Set them in Settings → Media, or as CLOUDFLARE_* environment variables.',
			)
		}
		const { CloudflareImagesAdapter } = await import('../adapters/cloudflare-images.js')
		return new CloudflareImagesAdapter({ accountId, apiToken, accountHash })
	}

	// `s3` is declared in the ProjectSettings enum but has no adapter yet — fall back.
	return new LocalFsAdapter()
}

/** The adapter name persisted on a media row, given a project's settings. */
export function effectiveAdapterName(settings: ProjectSettings | undefined): string {
	return envAdapterOverride() || settings?.mediaAdapter || 'local'
}

/** Max upload size in bytes (`MEDIA_MAX_SIZE` env, default 10MB). */
export function mediaMaxSize(): number {
	const parsed = Number(process.env.MEDIA_MAX_SIZE)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024
}

export const mediaPlugin = fp(async (app) => {
	await app.register(multipart, {
		limits: {
			fileSize: mediaMaxSize(),
		},
	})

	const adapter = await createMediaAdapter()
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

	app.log.info(`Media adapter: ${mediaAdapterName()}`)
})
