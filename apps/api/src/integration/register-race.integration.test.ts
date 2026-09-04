import { randomUUID } from 'node:crypto'
import { users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * First-admin registration must be exactly-once even under concurrent requests.
 * The shared test database is not empty, so the transactional guard is exercised
 * through the same path with the table pre-populated: every concurrent request
 * must be refused, and none may slip an extra admin in. Four requests stay
 * under the endpoint's 5/min rate limit so the guard, not the limiter, answers.
 */
describe.skipIf(!hasTestDb)('first-admin registration race (real Postgres)', () => {
	let app: FastifyInstance
	beforeAll(async () => {
		app = await buildTestApp()
	})
	afterAll(async () => {
		await app?.close()
	})

	it('refuses every concurrent registration once a user exists', async () => {
		const [{ count: before }] = await app.db
			.select({ count: users.id })
			.from(users)
			.where(eq(users.role, 'admin'))
			.then((rows) => [{ count: rows.length }])
		const results = await Promise.all(
			Array.from({ length: 4 }, (_, i) =>
				app.inject({
					method: 'POST',
					url: '/api/v1/auth/register',
					payload: {
						email: `race-${i}-${randomUUID().slice(0, 6)}@example.com`,
						name: 'Race',
						password: 'Password123!',
					},
				}),
			),
		)
		expect(results.map((r) => r.statusCode)).toEqual(Array(4).fill(403))
		const after = await app.db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
		expect(after.length).toBe(before)
	})
})
