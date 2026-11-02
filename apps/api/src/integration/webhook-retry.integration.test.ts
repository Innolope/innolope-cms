import { randomUUID } from 'node:crypto'
import { projects, users, webhookDeliveries, webhooks } from '@innolope/db'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { retryFailedDeliveries } from '../services/webhook-dispatch.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

// Never touch DNS or the network: every URL counts as public and safeFetch goes
// straight to the stubbed global fetch.
vi.mock('../adapters/connection-guard.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../adapters/connection-guard.js')>()
	return {
		...actual,
		validatePublicUrl: async () => null,
		safeFetch: (url: string, init?: RequestInit) => fetch(url, init),
	}
})

const minutes = (n: number) => new Date(Date.now() + n * 60_000)

// The unit tests fake the database; this runs the due-delivery query itself,
// which once interpolated a raw Date and failed on every sweep against Postgres.
describe.skipIf(!hasTestDb)('webhook retry sweep (real Postgres)', () => {
	let app: FastifyInstance
	let userId: string
	let projectId: string
	let webhookId: string

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({ email: `wh-retry-${short}@example.com`, name: 'Webhook Retry', role: 'admin' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Webhook Retry', slug: `wh-retry-${short}`, ownerId: user.id })
			.returning()
		projectId = project.id
		const [webhook] = await app.db
			.insert(webhooks)
			.values({ projectId, url: `https://hooks-${short}.example.com/in`, secret: 's'.repeat(32) })
			.returning()
		webhookId = webhook.id
	})

	afterEach(async () => {
		vi.unstubAllGlobals()
		await app.db.delete(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId))
	})

	afterAll(async () => {
		if (app) {
			await app.db.delete(projects).where(eq(projects.id, projectId))
			await app.db.delete(users).where(eq(users.id, userId))
		}
		await app?.close()
	})

	it('re-sends only due deliveries and records the outcome', async () => {
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const seed = (
			event: string,
			values: { status: 'pending' | 'failed'; attempts: number; nextRetry: Date | null },
		) => ({
			webhookId,
			event,
			payload: { type: event, data: { projectId }, timestamp: new Date().toISOString() },
			...values,
		})
		const rows = await app.db
			.insert(webhookDeliveries)
			.values([
				seed('backoff-elapsed', { status: 'failed', attempts: 1, nextRetry: minutes(-1) }),
				seed('lease-lapsed', { status: 'pending', attempts: 0, nextRetry: minutes(-1) }),
				seed('no-lease', { status: 'pending', attempts: 0, nextRetry: null }),
				seed('backoff-running', { status: 'failed', attempts: 1, nextRetry: minutes(5) }),
				seed('in-flight', { status: 'pending', attempts: 0, nextRetry: minutes(5) }),
				seed('gave-up', { status: 'failed', attempts: 3, nextRetry: minutes(-1) }),
			])
			.returning({ id: webhookDeliveries.id, event: webhookDeliveries.event })

		await retryFailedDeliveries(app)

		const after = await app.db
			.select()
			.from(webhookDeliveries)
			.where(
				inArray(
					webhookDeliveries.id,
					rows.map((r) => r.id),
				),
			)
		const byEvent = Object.fromEntries(after.map((r) => [r.event, r]))

		expect(fetchMock).toHaveBeenCalledTimes(3)
		for (const event of ['backoff-elapsed', 'lease-lapsed', 'no-lease']) {
			expect(byEvent[event]).toMatchObject({ status: 'success', statusCode: 200 })
		}
		expect(byEvent['backoff-elapsed'].attempts).toBe(2)
		for (const event of ['backoff-running', 'in-flight', 'gave-up']) {
			expect(byEvent[event].statusCode).toBeNull()
		}
		expect(byEvent['gave-up']).toMatchObject({ status: 'failed', attempts: 3 })
	})
})
