import { createHash, randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createOAuthAccessToken, verifyJwt } from '../plugins/auth.js'
import {
	authorizationServerMetadata,
	mcpResourceUrl,
	protectedResourceMetadata,
	publicBaseUrl,
} from '../services/oauth-metadata.js'

beforeAll(() => {
	process.env.AUTH_SECRET = 'test-secret-at-least-32-characters-long'
	// Ensure a deterministic base URL regardless of the runner's env.
	process.env.PUBLIC_URL = ''
})

const b64url = (buf: Buffer) =>
	buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('publicBaseUrl', () => {
	it('prefers PUBLIC_URL and strips a trailing slash', () => {
		process.env.PUBLIC_URL = 'https://cms.example.com/'
		const req = { headers: {}, protocol: 'http' } as never
		expect(publicBaseUrl(req)).toBe('https://cms.example.com')
		process.env.PUBLIC_URL = ''
	})

	it('honors X-Forwarded-Proto/Host behind a proxy', () => {
		const req = {
			headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cms.example.com' },
			protocol: 'http',
		} as never
		expect(publicBaseUrl(req)).toBe('https://cms.example.com')
	})

	it('falls back to the request protocol + host', () => {
		const req = { headers: { host: 'localhost:3001' }, protocol: 'http' } as never
		expect(publicBaseUrl(req)).toBe('http://localhost:3001')
	})
})

describe('OAuth metadata documents', () => {
	const base = 'https://cms.example.com'

	it('advertises the MCP resource and its authorization server', () => {
		const prm = protectedResourceMetadata(base)
		expect(prm.resource).toBe(`${base}/mcp`)
		expect(prm.authorization_servers).toEqual([base])
		expect(mcpResourceUrl(base)).toBe(`${base}/mcp`)
	})

	it('exposes PKCE-only authorization-server metadata', () => {
		const asm = authorizationServerMetadata(base)
		expect(asm.issuer).toBe(base)
		expect(asm.authorization_endpoint).toBe(`${base}/oauth/authorize`)
		expect(asm.token_endpoint).toBe(`${base}/oauth/token`)
		expect(asm.registration_endpoint).toBe(`${base}/oauth/register`)
		expect(asm.code_challenge_methods_supported).toEqual(['S256'])
		expect(asm.grant_types_supported).toContain('authorization_code')
		expect(asm.grant_types_supported).toContain('refresh_token')
	})
})

describe('OAuth access token', () => {
	it('is a JWT that verifyJwt accepts, carrying the user identity', async () => {
		const user = { id: 'u1', email: 'a@b.com', name: 'A', role: 'admin' as const }
		const token = await createOAuthAccessToken(user, {
			scope: 'mcp',
			clientId: 'mcp_123',
			audience: 'https://cms.example.com/mcp',
		})
		const decoded = await verifyJwt(token)
		expect(decoded).not.toBeNull()
		expect(decoded?.id).toBe('u1')
		expect(decoded?.email).toBe('a@b.com')
		expect(decoded?.role).toBe('admin')
	})
})

describe('PKCE S256 challenge', () => {
	// Documents the exact transform the token endpoint verifies against.
	it('matches base64url(sha256(verifier))', () => {
		const verifier = b64url(randomBytes(32))
		const challenge = b64url(createHash('sha256').update(verifier).digest())
		const recomputed = createHash('sha256').update(verifier).digest('base64url')
		expect(recomputed).toBe(challenge)
	})
})
