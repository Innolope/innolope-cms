import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, hasTestDb } from '../test/harness.js'

// Skipped unless TEST_DATABASE_URL points at a migrated Postgres (CI service).
// This is the seed for HTTP-level integration coverage — extend it with the
// content CRUD, auth, and multi-DB adapter critical paths.
describe.skipIf(!hasTestDb)('API integration (real Postgres)', () => {
	let app: FastifyInstance

	beforeAll(async () => {
		app = await buildTestApp()
	})

	afterAll(async () => {
		await app?.close()
	})

	it('reports the database as connected on the health check', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/v1/health' })
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.status).toBe('ok')
		expect(body.database).toBe('connected')
	})

	it('returns a JSON 404 for unknown API routes', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/v1/this-route-does-not-exist' })
		expect(res.statusCode).toBe(404)
		expect(res.json().error).toBe('Not found')
	})

	it('gates the audit-log endpoint behind authentication', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/v1/ee/audit-logs' })
		expect([401, 403]).toContain(res.statusCode)
	})
})
