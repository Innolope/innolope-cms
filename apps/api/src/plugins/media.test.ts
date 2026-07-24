import type { ProjectSettings } from '@innolope/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	effectiveAdapterName,
	MediaConfigError,
	mediaAdapterName,
	resolveMediaAdapter,
} from './media.js'

const CF_ENV = {
	CLOUDFLARE_ACCOUNT_ID: 'env-account',
	CLOUDFLARE_API_TOKEN: 'env-token',
	CLOUDFLARE_IMAGES_ACCOUNT_HASH: 'env-hash',
}

const settings = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
	locales: ['en'],
	defaultLocale: 'en',
	mediaAdapter: 'local',
	...over,
})

afterEach(() => {
	vi.unstubAllEnvs()
})

function stubEnv(vars: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) vi.stubEnv(key, '')
		else vi.stubEnv(key, value)
	}
}

describe('resolveMediaAdapter in cloud mode', () => {
	it('coerces local to cloudflare with platform origin', async () => {
		stubEnv({ CLOUD_MODE: 'true', MEDIA_ADAPTER: '', ...CF_ENV })
		const resolved = await resolveMediaAdapter(settings({ mediaAdapter: 'local' }), {
			projectId: 'p1',
		})
		expect(resolved.adapterName).toBe('cloudflare')
		expect(resolved.origin).toBe('platform')
		expect(resolved.credsSource).toBe('env')
	})

	it('coerces the unimplemented s3 choice too', async () => {
		stubEnv({ CLOUD_MODE: 'true', MEDIA_ADAPTER: '', ...CF_ENV })
		const resolved = await resolveMediaAdapter(settings({ mediaAdapter: 's3' }))
		expect(resolved.adapterName).toBe('cloudflare')
	})

	it('fails loudly instead of falling back to local disk when env creds are missing', async () => {
		stubEnv({
			CLOUD_MODE: 'true',
			MEDIA_ADAPTER: '',
			CLOUDFLARE_ACCOUNT_ID: '',
			CLOUDFLARE_API_TOKEN: '',
			CLOUDFLARE_IMAGES_ACCOUNT_HASH: '',
		})
		await expect(resolveMediaAdapter(settings())).rejects.toThrow(MediaConfigError)
	})

	it('prefers the project own credentials and marks the origin theirs', async () => {
		stubEnv({ CLOUD_MODE: 'true', MEDIA_ADAPTER: '', ...CF_ENV })
		const resolved = await resolveMediaAdapter(
			settings({
				mediaAdapter: 'cloudflare',
				cloudflare: { accountId: 'own', apiToken: 'own-token', imagesAccountHash: 'own-hash' },
			}),
		)
		expect(resolved.origin).toBe('project')
		expect(resolved.credsSource).toBe('project-settings')
	})
})

describe('resolveMediaAdapter on self-host', () => {
	it('keeps local as local with project origin', async () => {
		stubEnv({ CLOUD_MODE: '', MEDIA_ADAPTER: '' })
		const resolved = await resolveMediaAdapter(settings({ mediaAdapter: 'local' }))
		expect(resolved.adapterName).toBe('local')
		expect(resolved.origin).toBe('project')
	})

	it('treats env-credentialed cloudflare as the operator own storage', async () => {
		stubEnv({ CLOUD_MODE: '', MEDIA_ADAPTER: '', ...CF_ENV })
		const resolved = await resolveMediaAdapter(settings({ mediaAdapter: 'cloudflare' }))
		expect(resolved.credsSource).toBe('env')
		expect(resolved.origin).toBe('project')
	})
})

describe('adapter names in cloud mode', () => {
	it('effectiveAdapterName never reports local in cloud', () => {
		stubEnv({ CLOUD_MODE: 'true', MEDIA_ADAPTER: '' })
		expect(effectiveAdapterName(settings({ mediaAdapter: 'local' }))).toBe('cloudflare')
	})

	it('mediaAdapterName reports cloudflare for the boot adapter in cloud', () => {
		stubEnv({ CLOUD_MODE: 'true', MEDIA_ADAPTER: '' })
		expect(mediaAdapterName()).toBe('cloudflare')
		stubEnv({ CLOUD_MODE: '' })
		expect(mediaAdapterName()).toBe('local')
	})
})
