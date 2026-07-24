import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	buildAuthorizeUrl,
	cloudflareOauthEnabled,
	discoverImagesAccountHash,
	exchangeCode,
	newPkcePair,
	newStateNonce,
} from './cloudflare-oauth.js'

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('cloudflareOauthEnabled', () => {
	it('is off until a client id is configured', () => {
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_ID', '')
		expect(cloudflareOauthEnabled()).toBe(false)
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_ID', 'client-123')
		expect(cloudflareOauthEnabled()).toBe(true)
	})
})

describe('newPkcePair', () => {
	it('produces an S256 challenge of the verifier', async () => {
		const { verifier, challenge } = newPkcePair()
		const { createHash } = await import('node:crypto')
		expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
		expect(verifier).not.toBe(newPkcePair().verifier)
	})
})

describe('buildAuthorizeUrl', () => {
	it('targets the dash.cloudflare.com authorize endpoint with PKCE', () => {
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_ID', 'client-123')
		const url = new URL(
			buildAuthorizeUrl({
				state: 'state-1',
				codeChallenge: 'challenge-1',
				redirectUri: 'https://cms.example.com/api/v1/integrations/cloudflare/callback',
			}),
		)
		expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth')
		expect(url.searchParams.get('response_type')).toBe('code')
		expect(url.searchParams.get('client_id')).toBe('client-123')
		expect(url.searchParams.get('state')).toBe('state-1')
		expect(url.searchParams.get('code_challenge')).toBe('challenge-1')
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('scope')).toContain('images.write')
	})
})

describe('exchangeCode', () => {
	it('posts the code with PKCE verifier and client secret', async () => {
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_ID', 'client-123')
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_SECRET', 'secret-456')
		const fetchMock = vi.fn(async () =>
			Response.json({
				access_token: 'at',
				refresh_token: 'rt',
				expires_in: 3600,
				scope: 'images.read images.write',
			}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const tokens = await exchangeCode('code-1', 'verifier-1', 'https://cms.example.com/cb')
		expect(tokens.accessToken).toBe('at')
		expect(tokens.refreshToken).toBe('rt')
		expect(tokens.scopes).toEqual(['images.read', 'images.write'])
		expect(tokens.expiresAt).toBeInstanceOf(Date)

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://dash.cloudflare.com/oauth2/token')
		const body = new URLSearchParams(init.body as string)
		expect(body.get('grant_type')).toBe('authorization_code')
		expect(body.get('code')).toBe('code-1')
		expect(body.get('code_verifier')).toBe('verifier-1')
		expect(body.get('client_secret')).toBe('secret-456')
	})

	it('throws with the provider error when the exchange fails', async () => {
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_ID', 'client-123')
		vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_SECRET', 'secret-456')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })),
		)
		await expect(exchangeCode('bad', 'v', 'https://cms.example.com/cb')).rejects.toThrow(
			/invalid_grant/,
		)
	})
})

describe('discoverImagesAccountHash', () => {
	it('parses the hash from an existing image variant', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					result: {
						images: [{ variants: ['https://imagedelivery.net/THE_HASH/some-id/public'] }],
					},
				}),
			),
		)
		await expect(discoverImagesAccountHash('token', 'acc')).resolves.toBe('THE_HASH')
	})

	it('uploads and deletes a probe when the account has no images', async () => {
		const calls: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push(`${init?.method || 'GET'} ${url}`)
				if (!init?.method) return Response.json({ result: { images: [] } })
				if (init.method === 'POST') {
					return Response.json({
						result: {
							id: 'probe-id',
							variants: ['https://imagedelivery.net/PROBE_HASH/probe-id/public'],
						},
					})
				}
				return Response.json({ result: {} })
			}),
		)
		await expect(discoverImagesAccountHash('token', 'acc')).resolves.toBe('PROBE_HASH')
		expect(calls.some((c) => c.startsWith('DELETE') && c.includes('probe-id'))).toBe(true)
	})
})

describe('newStateNonce', () => {
	it('is long and unique', () => {
		const a = newStateNonce()
		expect(a.length).toBeGreaterThanOrEqual(24)
		expect(a).not.toBe(newStateNonce())
	})
})
