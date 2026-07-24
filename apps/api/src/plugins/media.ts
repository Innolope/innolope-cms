import multipart from '@fastify/multipart'
import type { ProjectSettings } from '@innolope/db'
import type { MediaAdapter } from '@innolope/types'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { LocalFsAdapter } from '../adapters/local-fs.js'
import { isCloudMode } from '../lib/cloud-mode.js'

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

/**
 * The configured media adapter name (`MEDIA_ADAPTER` env, default `local`).
 * In cloud mode local disk is never allowed — the container filesystem is
 * ephemeral, so anything written there vanishes on the next deploy.
 */
export function mediaAdapterName(): string {
	const name = process.env.MEDIA_ADAPTER || 'local'
	return isCloudMode() && name === 'local' ? 'cloudflare' : name
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
				defaultVariant: process.env.CLOUDFLARE_IMAGES_VARIANT,
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
 * The adapter a project's settings actually resolve to.
 *
 * In cloud mode, `local` (and the unimplemented `s3`, which would fall back to
 * local) is coerced to `cloudflare`: images must never live on the API
 * container's disk, and existing projects with `mediaAdapter: 'local'` simply
 * mean "platform default" there — no settings migration needed.
 */
function resolveAdapterName(settings: ProjectSettings | undefined): string {
	const name = envAdapterOverride() || settings?.mediaAdapter || 'local'
	if (isCloudMode() && (name === 'local' || name === 's3')) return 'cloudflare'
	return name
}

/** Where uploaded bytes physically live — drives the ownership tag in the media grid. */
export type MediaOrigin = 'platform' | 'project'

export interface ResolvedMediaAdapter {
	adapter: MediaAdapter
	/** The adapter name persisted on media rows. */
	adapterName: string
	/**
	 * `platform` when files land in the shared cloud (Innolope) Cloudflare
	 * account — env credentials in cloud mode. Everything else is the
	 * customer's own storage (`project`): their Cloudflare account via project
	 * settings, or the operator's storage on self-host.
	 */
	origin: MediaOrigin
	credsSource: 'oauth' | 'project-settings' | 'env' | 'none'
}

/**
 * Build the media adapter for a single project.
 *
 * The project's `settings.mediaAdapter` decides, unless a non-`local` `MEDIA_ADAPTER`
 * env var forces a global override. Cloudflare credentials come from the project
 * settings first, falling back to the server-level `CLOUDFLARE_*` env vars — which in
 * cloud mode are the platform's own account.
 *
 * Origin is derived from the same branch that picked the credentials so the two can
 * never disagree.
 */
export async function resolveMediaAdapter(
	settings: ProjectSettings | undefined,
	opts?: { projectId?: string; app?: FastifyInstance },
): Promise<ResolvedMediaAdapter> {
	const name = resolveAdapterName(settings)

	if (name === 'cloudflare') {
		const cf = settings?.cloudflare ?? {}

		// Highest priority: an active "Connect Cloudflare" OAuth connection —
		// the user's own account, tokens managed (and refreshed) server-side.
		if (opts?.app && opts.projectId && cf.source === 'oauth') {
			const { getAccessToken } = await import('../services/cloudflare-oauth.js')
			const oauthToken = await getAccessToken(opts.app, opts.projectId)
			if (oauthToken && cf.accountId && cf.imagesAccountHash) {
				const { CloudflareImagesAdapter } = await import('../adapters/cloudflare-images.js')
				return {
					adapter: new CloudflareImagesAdapter({
						accountId: cf.accountId,
						apiToken: oauthToken,
						accountHash: cf.imagesAccountHash,
						defaultVariant: cf.imagesVariant || process.env.CLOUDFLARE_IMAGES_VARIANT,
					}),
					adapterName: 'cloudflare',
					origin: 'project',
					credsSource: 'oauth',
				}
			}
		}

		const hasOwnCreds = Boolean(cf.accountId && cf.apiToken && cf.imagesAccountHash)
		const accountId = cf.accountId || process.env.CLOUDFLARE_ACCOUNT_ID
		const apiToken = cf.apiToken || process.env.CLOUDFLARE_API_TOKEN
		const accountHash = cf.imagesAccountHash || process.env.CLOUDFLARE_IMAGES_ACCOUNT_HASH
		if (!accountId || !apiToken || !accountHash) {
			throw new MediaConfigError(
				isCloudMode()
					? 'Cloud media storage is misconfigured: the CLOUDFLARE_* environment variables are missing. This is a deployment error — local disk is never used in cloud mode.'
					: 'Cloudflare Images is selected for this project but credentials are incomplete. ' +
							'Set them in Settings → Media, or as CLOUDFLARE_* environment variables.',
			)
		}
		const credsSource = hasOwnCreds ? 'project-settings' : 'env'
		const origin: MediaOrigin = credsSource === 'env' && isCloudMode() ? 'platform' : 'project'
		const { CloudflareImagesAdapter } = await import('../adapters/cloudflare-images.js')
		const adapter = new CloudflareImagesAdapter({
			accountId,
			apiToken,
			accountHash,
			defaultVariant: cf.imagesVariant || process.env.CLOUDFLARE_IMAGES_VARIANT,
			// Tag uploads into the shared platform account with their project so
			// they stay attributable (migration, audits, cleanup). Never tag
			// uploads into a customer's own account.
			uploadMetadata:
				origin === 'platform' && opts?.projectId
					? { projectId: opts.projectId, source: 'innolope-cms' }
					: undefined,
		})
		return { adapter, adapterName: 'cloudflare', origin, credsSource }
	}

	// `s3` is declared in the ProjectSettings enum but has no adapter yet — fall
	// back to local disk (self-host only; cloud mode never reaches this branch).
	return {
		adapter: new LocalFsAdapter(),
		adapterName: 'local',
		origin: 'project',
		credsSource: 'none',
	}
}

/** The adapter name persisted on a media row, given a project's settings. */
export function effectiveAdapterName(settings: ProjectSettings | undefined): string {
	const name = resolveAdapterName(settings)
	// `s3` still falls back to the local adapter — record what actually ran.
	return name === 's3' ? 'local' : name
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
