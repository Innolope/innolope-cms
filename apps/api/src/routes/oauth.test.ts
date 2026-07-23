import { createHash, randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import { beforeAll, describe, expect, it } from 'vitest'
import { createJwt, createOAuthAccessToken, verifyOAuthAccessToken } from '../plugins/auth.js'
import {
	authorizationServerMetadata,
	mcpResourceUrl,
	protectedResourceMetadata,
	publicBaseUrl,
} from '../services/oauth-metadata.js'
import { wellKnownRoutes } from './oauth.js'

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

describe('well-known discovery routes', () => {
	const build = async () => {
		process.env.PUBLIC_URL = 'https://cms.example.com'
		const app = Fastify()
		await app.register(wellKnownRoutes)
		await app.ready()
		return app
	}

	it('serves protected-resource metadata as JSON at both the root and RFC 9728 path-suffixed URLs', async () => {
		const app = await build()
		// RFC 9728 §3.1: clients derive the metadata URL by inserting the well-known
		// segment before the resource path (`/mcp`). Both must return JSON — the
		// suffixed one previously fell through to the SPA catch-all (HTML), which
		// silently broke the Claude connector's OAuth discovery.
		for (const url of [
			'/.well-known/oauth-protected-resource',
			'/.well-known/oauth-protected-resource/mcp',
		]) {
			const res = await app.inject({ method: 'GET', url })
			expect(res.statusCode, url).toBe(200)
			expect(res.headers['content-type'], url).toContain('application/json')
			expect(res.json().resource, url).toBe('https://cms.example.com/mcp')
		}
		await app.close()
		process.env.PUBLIC_URL = ''
	})

	it('serves authorization-server metadata as JSON at the root and path-suffixed URLs', async () => {
		const app = await build()
		for (const url of [
			'/.well-known/oauth-authorization-server',
			'/.well-known/oauth-authorization-server/mcp',
		]) {
			const res = await app.inject({ method: 'GET', url })
			expect(res.statusCode, url).toBe(200)
			expect(res.headers['content-type'], url).toContain('application/json')
			expect(res.json().issuer, url).toBe('https://cms.example.com')
		}
		await app.close()
		process.env.PUBLIC_URL = ''
	})
})

describe('MCP OAuth access token', () => {
	const audience = 'https://cms.example.com/mcp'
	const user = { id: 'u1', email: 'a@b.com', name: 'A', role: 'admin' as const }

	it('verifies with the correct audience + token_use and carries identity', async () => {
		const token = await createOAuthAccessToken(user, {
			scope: 'mcp',
			clientId: 'mcp_123',
			audience,
		})
		const decoded = await verifyOAuthAccessToken(token, { audience })
		expect(decoded).not.toBeNull()
		expect(decoded?.id).toBe('u1')
		expect(decoded?.role).toBe('admin')
	})

	it('rejects a token minted for a different audience', async () => {
		const token = await createOAuthAccessToken(user, {
			scope: 'mcp',
			clientId: 'mcp_123',
			audience,
		})
		expect(
			await verifyOAuthAccessToken(token, { audience: 'https://evil.example.com/mcp' }),
		).toBeNull()
	})

	it('rejects a plain web-login JWT (no audience / token_use) at the MCP boundary', async () => {
		const login = await createJwt(user)
		expect(await verifyOAuthAccessToken(login, { audience })).toBeNull()
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
