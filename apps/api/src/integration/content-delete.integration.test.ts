import { collections, content, projects } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, hasTestDb } from '../test/harness.js'

/**
 * HTTP-level coverage of DELETE /api/v1/content/:id — in particular the
 * external-cleanup contract: a clean delete answers 204; when the CMS row is
 * gone but the backing external record could not be removed, the API answers
 * 200 with { deleted, externalCleanup: 'failed', message } instead of silently
 * swallowing the failure.
 */
describe.skipIf(!hasTestDb)('DELETE /api/v1/content/:id (real Postgres)', () => {
	let app: FastifyInstance
	let token: string
	let projectId: string

	const authed = (extra: Record<string, string> = {}) => ({
		authorization: `Bearer ${token}`,
		'x-project-id': projectId,
		...extra,
	})

	beforeAll(async () => {
		app = await buildTestApp()

		// First user registers as admin and gets the JWT via cookie.
		const reg = await app.inject({
			method: 'POST',
			url: '/api/v1/auth/register',
			payload: {
				email: 'delete-e2e@test.local',
				password: 'Delete-E2e-Passw0rd!',
				name: 'Delete E2E',
			},
		})
		expect(reg.statusCode).toBe(201)
		const cookie = reg.cookies.find((c) => c.name === 'innolope_token')
		expect(cookie).toBeDefined()
		token = (cookie as { value: string }).value

		const proj = await app.inject({
			method: 'POST',
			url: '/api/v1/projects',
			headers: { authorization: `Bearer ${token}` },
			payload: { name: 'Delete E2E', slug: 'delete-e2e' },
		})
		expect(proj.statusCode).toBe(201)
		projectId = proj.json().id
	})

	afterAll(async () => {
		if (app && projectId) {
			await app.db.delete(projects).where(eq(projects.id, projectId))
		}
		await app?.close()
	})

	it('answers 204 for a clean delete of internal content', async () => {
		const col = await app.inject({
			method: 'POST',
			url: '/api/v1/collections',
			headers: authed(),
			payload: { name: 'notes', label: 'Notes', fields: [{ name: 'title', type: 'text' }] },
		})
		expect(col.statusCode).toBe(201)

		const created = await app.inject({
			method: 'POST',
			url: '/api/v1/content',
			headers: authed(),
			payload: {
				collectionId: col.json().id,
				slug: 'note-1',
				markdown: '# Note 1',
				metadata: { title: 'Note 1' },
			},
		})
		expect(created.statusCode).toBe(201)
		const id = created.json().id

		const del = await app.inject({
			method: 'DELETE',
			url: `/api/v1/content/${id}`,
			headers: authed(),
		})
		expect(del.statusCode).toBe(204)
		expect(del.body).toBe('')

		const gone = await app.inject({
			method: 'GET',
			url: `/api/v1/content/${id}`,
			headers: authed(),
		})
		expect(gone.statusCode).toBe(404)
	})

	it('answers 200 with an externalCleanup warning when the external delete fails', async () => {
		// Point the project at an unreachable external database so the propagated
		// delete fails, and seed an external-backed collection + content row.
		await app.db
			.update(projects)
			.set({
				settings: {
					externalDb: {
						type: 'postgresql',
						connectionString: 'postgresql://nobody:nope@127.0.0.1:9/nowhere',
					},
				},
			})
			.where(eq(projects.id, projectId))

		const [col] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: 'ext_things',
				label: 'External Things',
				source: 'external',
				accessMode: 'read-write',
				externalTable: 'things',
				fields: [{ name: 'title', type: 'text' }],
			})
			.returning()

		const [row] = await app.db
			.insert(content)
			.values({
				projectId,
				collectionId: col.id,
				slug: 'ext-thing-1',
				markdown: '# Ext thing',
				externalId: 'ext-123',
			})
			.returning()

		const del = await app.inject({
			method: 'DELETE',
			url: `/api/v1/content/${row.id}`,
			headers: authed(),
		})
		expect(del.statusCode).toBe(200)
		const body = del.json()
		expect(body.deleted).toBe(true)
		expect(body.externalCleanup).toBe('failed')
		expect(body.message).toContain('things')
		expect(body.message).toContain('ext-123')

		// The CMS row is gone despite the failed external cleanup.
		const [remaining] = await app.db.select().from(content).where(eq(content.id, row.id))
		expect(remaining).toBeUndefined()
	})
})
