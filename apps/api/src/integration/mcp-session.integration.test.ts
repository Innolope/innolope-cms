import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOAuthAccessToken } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * Streamable-HTTP session contract: an UNKNOWN session id must be answered
 * with 404 — that status is the MCP client's signal to transparently start a
 * new session. (It used to be 400, which left clients stuck erroring after
 * every redeploy wiped the in-memory session map.) A missing session id on
 * GET/DELETE stays 400: that's a malformed request, not an expired session.
 */
describe.skipIf(!hasTestDb)('MCP session recovery (real Postgres)', () => {
	let app: FastifyInstance
	let token: string
	const HOST = 'mcp-test.local'

	const headers = (extra: Record<string, string> = {}) => ({
		host: HOST,
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		...extra,
	})

	beforeAll(async () => {
		app = await buildTestApp()
		token = await createOAuthAccessToken(
			{ id: randomUUID(), email: 'mcp-e2e@test.local', name: 'MCP E2E', role: 'admin' },
			{ scope: 'mcp', clientId: 'test-client', audience: `http://${HOST}/mcp` },
		)
	})

	afterAll(async () => {
		await app?.close()
	})

	it('answers an unknown session id on POST with 404 (re-initialize signal)', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/mcp',
			headers: headers({ 'mcp-session-id': randomUUID() }),
			payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
		})
		expect(res.statusCode).toBe(404)
		expect(res.json().error.message).toContain('re-initialize')
	})

	it('answers an unknown session id on GET with 404', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/mcp',
			headers: headers({ 'mcp-session-id': randomUUID() }),
		})
		expect(res.statusCode).toBe(404)
	})

	it('keeps 400 for a missing session id (malformed, not expired)', async () => {
		const get = await app.inject({ method: 'GET', url: '/mcp', headers: headers() })
		expect(get.statusCode).toBe(400)

		const post = await app.inject({
			method: 'POST',
			url: '/mcp',
			headers: headers(),
			payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
		})
		expect(post.statusCode).toBe(400)
	})

	it('still rejects missing/invalid tokens with 401', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/mcp',
			headers: { host: HOST, 'content-type': 'application/json' },
			payload: { jsonrpc: '2.0', method: 'initialize', id: 1 },
		})
		expect(res.statusCode).toBe(401)
	})
})
