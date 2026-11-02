import { randomUUID } from 'node:crypto'
import { collections, projectMembers, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb, TEST_DB_URL } from '../test/harness.js'

describe.skipIf(!hasTestDb)('editor review regressions', () => {
	let app: Awaited<ReturnType<typeof buildTestApp>>
	let source: postgres.Sql
	let userId: string
	let projectId: string
	let collectionId: string
	let externalId: string
	let headers: Record<string, string>
	const table = `editor_review_${randomUUID().slice(0, 8)}`
	beforeAll(async () => {
		app = await buildTestApp()
		source = postgres(TEST_DB_URL ?? '', { onnotice: () => {} })
		const [user] = await app.db
			.insert(users)
			.values({ email: `${table}@example.test`, name: 'Editor review' })
			.returning()
		userId = user.id
		const [project] = await app.db
			.insert(projects)
			.values({
				name: table,
				slug: table,
				ownerId: userId,
				settings: { externalDb: { type: 'postgresql', connectionString: TEST_DB_URL } } as never,
			})
			.returning()
		projectId = project.id
		await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
		const rows = await app.db
			.insert(collections)
			.values([
				{ projectId, name: `${table}_local`, label: 'Local', fields: [] },
				{
					projectId,
					name: table,
					label: 'External',
					fields: [{ name: 'title', type: 'text' }],
					source: 'external',
					externalTable: table,
				},
			])
			.returning()
		collectionId = rows[0].id
		externalId = rows[1].id
		await source`CREATE TABLE ${source(table)} (id serial PRIMARY KEY, title text)`
		await source`INSERT INTO ${source(table)} (title) VALUES ('Uncached source row')`
		headers = {
			authorization: `Bearer ${await createJwt({ id: user.id, email: user.email, name: user.name, role: 'editor' })}`,
			'x-project-id': projectId,
		}
	})
	afterAll(async () => {
		if (app && projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		if (app && userId) await app.db.delete(users).where(eq(users.id, userId))
		if (source) {
			await source`DROP TABLE IF EXISTS ${source(table)}`
			await source.end()
		}
		await app?.close()
	})
	it('dates internal bulk creation without relying on attribution being populated', async () => {
		const response = await app.inject({
			method: 'POST',
			url: '/api/v1/content/bulk',
			headers,
			payload: {
				items: [{ collectionId, slug: `bulk-${randomUUID()}`, markdown: 'New bulk authoring' }],
			},
		})
		expect(response.statusCode).toBe(201)
		expect(Number.isFinite(Date.parse(response.json().data[0].contentEditedAt))).toBe(true)
	})
	it.each([
		'editedFrom=2099-01-01T00%3A00%3A00Z',
		'sortBy=contentEditedAt',
	])('does not replace meaningful-date results with unfiltered source rows: %s', async (query) => {
		const response = await app.inject({
			method: 'GET',
			url: `/api/v1/content?collectionId=${externalId}&${query}`,
			headers,
		})
		expect(response.statusCode).toBe(200)
		expect(response.json().data).toEqual([])
	})
})
