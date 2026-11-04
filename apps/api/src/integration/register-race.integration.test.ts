import { randomUUID } from 'node:crypto'
import { users } from '@innolope/db'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * First-admin registration must be exactly-once even under concurrent requests.
 * The transactional guard is exercised with the users table pre-populated: every
 * concurrent request must be refused, and none may slip an extra admin in. The
 * suite seeds its own user — the shared test database is empty whenever this
 * file runs before the others (or alone), and the first registration then
 * rightly succeeds. Four requests stay under the endpoint's 5/min rate limit so
 * the guard, not the limiter, answers.
 */
describe.skipIf(!hasTestDb)('first-admin registration race (real Postgres)', () => {
	let app: FastifyInstance
	let seedId: string
	beforeAll(async () => {
		app = await buildTestApp()
		const [seed] = await app.db
			.insert(users)
			.values({
				email: `race-seed-${randomUUID().slice(0, 8)}@example.com`,
				name: 'Seed',
				role: 'editor',
			})
			.returning({ id: users.id })
		seedId = seed.id
	})
	afterAll(async () => {
		if (seedId) await app.db.delete(users).where(eq(users.id, seedId))
		await app?.close()
	})

	it('refuses every concurrent registration once a user exists', async () => {
		const emails = Array.from(
			{ length: 4 },
			(_, i) => `race-${i}-${randomUUID().slice(0, 6)}@example.com`,
		)
		const results = await Promise.all(
			emails.map((email) =>
				app.inject({
					method: 'POST',
					url: '/api/v1/auth/register',
					payload: { email, name: 'Race', password: 'Password123!' },
				}),
			),
		)
		expect(results.map((r) => r.statusCode)).toEqual(Array(4).fill(403))
		// Check these requests' own accounts, not a global admin count: other test
		// files share the database and create admins in parallel.
		const created = await app.db
			.select({ id: users.id })
			.from(users)
			.where(inArray(users.email, emails))
		expect(created).toHaveLength(0)
	})
})
