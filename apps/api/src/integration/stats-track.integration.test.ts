import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	contentAnalytics,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('POST /api/v1/stats/track (real Postgres)', () => {
	let app: FastifyInstance
	let token: string
	let projectId: string
	let collectionId: string
	let userId: string

	const authed = () => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })

	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({ email: `track-${short}@example.com`, name: 'Track Tester', role: 'admin' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Track Test', slug: `track-${short}`, ownerId: user.id })
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId: user.id, role: 'admin' })
		const [col] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: 'posts',
				label: 'Posts',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()
		collectionId = col.id
		token = await createJwt({ id: user.id, email: user.email, name: user.name, role: 'admin' })
	})

	afterAll(async () => {
		if (app && projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (app && userId) await app.db.delete(users).where(eq(users.id, userId))
		await app?.close()
	})

	const track = (contentId: string, query?: string) =>
		app.inject({
			method: 'POST',
			url: '/api/v1/stats/track',
			headers: authed(),
			payload: { event: 'mcp_read', source: 'mcp', contentId, ...(query && { query }) },
		})

	const rowsFor = (query: string) =>
		app.db
			.select()
			.from(contentAnalytics)
			.where(and(eq(contentAnalytics.projectId, projectId), eq(contentAnalytics.query, query)))

	// The reported 500: records in an external database are read by their source
	// id, which the uuid column cannot parse. The read must still be counted.
	it('records a read of an external record unattributed instead of failing', async () => {
		const marker = `objectid-${randomUUID().slice(0, 8)}`
		const res = await track('6a084453412c8d5d216978e0', marker)
		expect(res.statusCode).toBe(204)

		const [row] = await rowsFor(marker)
		expect(row).toBeDefined()
		expect(row.contentId).toBeNull()
		expect(row.event).toBe('mcp_read')
		expect(row.source).toBe('mcp')
	})

	// A well-formed id whose content is gone trips the foreign key rather than the
	// uuid parser, so the shape check alone does not cover it.
	it('records a read of deleted content unattributed instead of failing', async () => {
		const marker = `deleted-${randomUUID().slice(0, 8)}`
		const res = await track(randomUUID(), marker)
		expect(res.statusCode).toBe(204)

		const [row] = await rowsFor(marker)
		expect(row).toBeDefined()
		expect(row.contentId).toBeNull()
	})

	it('attributes a read of a record that does exist', async () => {
		const [item] = await app.db
			.insert(content)
			.values({
				projectId,
				collectionId,
				slug: `tracked-${randomUUID().slice(0, 6)}`,
				markdown: '',
			})
			.returning()
		const marker = `attributed-${randomUUID().slice(0, 8)}`
		const res = await track(item.id, marker)
		expect(res.statusCode).toBe(204)

		const [row] = await rowsFor(marker)
		expect(row.contentId).toBe(item.id)

		// And it reaches the analytics report the attribution exists for.
		const report = await app.inject({
			method: 'GET',
			url: '/api/v1/stats/analytics',
			headers: authed(),
		})
		expect(report.statusCode).toBe(200)
		expect(
			report.json().topContent.some((c: { contentId: string }) => c.contentId === item.id),
		).toBe(true)
	})
})
