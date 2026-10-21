import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	contentVersions,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createExternalDbAdapter } from '../adapters/external-db.js'
import { createJwt } from '../plugins/auth.js'
import { syncMarkdownCache } from '../services/markdown-cache.js'
import { buildTestApp, hasTestDb, TEST_DB_URL } from '../test/harness.js'

/**
 * Write-through to a real PostgreSQL source table. The source table lives in the
 * test database itself, so the suite needs nothing beyond `TEST_DATABASE_URL`.
 */
describe.skipIf(!hasTestDb)(
	'external write-through (real Postgres source)',
	{ timeout: 30_000 },
	() => {
		let app: FastifyInstance
		let source: postgres.Sql
		let projectId: string
		let userId: string
		let token: string
		let collection: typeof collections.$inferSelect
		const table = `ext_src_${randomUUID().slice(0, 8)}`
		const SOURCE_URL = TEST_DB_URL ?? ''

		const headers = () => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })

		async function cachedRow(sourceId: number) {
			const [row] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.collectionId, collection.id), eq(content.externalId, String(sourceId))),
				)
			return row
		}

		async function sourceRow(sourceId: number) {
			const [row] = await source`SELECT * FROM ${source(table)} WHERE id = ${sourceId}`
			return row
		}

		async function seed(values: Record<string, unknown>) {
			const [row] = await source`INSERT INTO ${source(table)} ${source(values)} RETURNING id`
			const adapter = createExternalDbAdapter({
				type: 'postgresql',
				connectionString: SOURCE_URL,
			})
			await adapter.connect()
			try {
				await syncMarkdownCache(app.db, content, adapter, collection as never, {
					versionTable: contentVersions,
				})
			} finally {
				await adapter.disconnect()
			}
			return row.id as number
		}

		async function put(id: string, payload: Record<string, unknown>) {
			return app.inject({
				method: 'PUT',
				url: `/api/v1/content/${id}`,
				headers: headers(),
				payload,
			})
		}

		beforeAll(async () => {
			app = await buildTestApp()
			source = postgres(SOURCE_URL, { onnotice: () => {} })
			await source`
			CREATE TABLE ${source(table)} (
				id serial PRIMARY KEY,
				title text NOT NULL,
				price integer,
				meta jsonb,
				views integer NOT NULL DEFAULT 0
			)
		`
			const short = randomUUID().slice(0, 8)
			const [user] = await app.db
				.insert(users)
				.values({ email: `ew-${short}@example.com`, name: 'EW', role: 'editor' })
				.returning()
			userId = user.id
			const [project] = await app.db
				.insert(projects)
				.values({
					name: 'External write',
					slug: `ew-${short}`,
					ownerId: userId,
					settings: {
						externalDb: {
							type: 'postgresql',
							connectionString: TEST_DB_URL,
							accessMode: 'read-write',
						},
					} as never,
				})
				.returning()
			projectId = project.id
			await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
			;[collection] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: table,
					label: 'Source',
					source: 'external',
					externalTable: table,
					accessMode: 'read-write',
					fields: [
						{ name: 'title', type: 'text' },
						{ name: 'price', type: 'number' },
						{ name: 'meta', type: 'object' },
						{ name: 'views', type: 'number' },
					],
				})
				.returning()
			token = await createJwt({ id: userId, email: user.email, name: 'EW', role: 'editor' })
		})

		afterAll(async () => {
			if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
			if (userId) await app.db.delete(users).where(eq(users.id, userId))
			if (source) {
				await source`DROP TABLE IF EXISTS ${source(table)}`
				await source.end()
			}
			await app?.close()
		})

		it('writes only the changed column and keeps another client’s concurrent edit', async () => {
			const sourceId = await seed({ title: 'Original', price: 10, meta: { a: 1 } })
			const cached = await cachedRow(sourceId)
			// Another client bumps the counter after the CMS cached the row.
			await source`UPDATE ${source(table)} SET views = 42 WHERE id = ${sourceId}`

			const res = await put(cached.id, {
				metadata: { ...(cached.metadata as Record<string, unknown>), title: 'Edited' },
			})
			expect(res.statusCode).toBe(200)

			const row = await sourceRow(sourceId)
			expect(row.title).toBe('Edited')
			expect(row.views).toBe(42)
			expect(row.price).toBe(10)
			expect(row.meta).toEqual({ a: 1 })
		})

		it('writes a cleared number as NULL instead of failing on an empty string', async () => {
			const sourceId = await seed({ title: 'Priced', price: 99 })
			const cached = await cachedRow(sourceId)
			const res = await put(cached.id, { metadata: { price: '' } })
			expect(res.statusCode).toBe(200)
			expect((await sourceRow(sourceId)).price).toBeNull()
		})

		it('removes a column value the editor explicitly removed', async () => {
			const sourceId = await seed({ title: 'Removable', price: 5 })
			const cached = await cachedRow(sourceId)
			const res = await put(cached.id, { metadata: { price: null } })
			expect(res.statusCode).toBe(200)
			expect((await sourceRow(sourceId)).price).toBeNull()
		})

		it('does not write at all when the save changes nothing', async () => {
			const sourceId = await seed({ title: 'Stable' })
			const cached = await cachedRow(sourceId)
			// Changed underneath the CMS; a no-op save must not revert it.
			await source`UPDATE ${source(table)} SET title = 'Changed elsewhere' WHERE id = ${sourceId}`
			const res = await put(cached.id, { metadata: cached.metadata as Record<string, unknown> })
			expect(res.statusCode).toBe(200)
			expect((await sourceRow(sourceId)).title).toBe('Changed elsewhere')
		})

		it('omits an emptied number on insert so the column default applies', async () => {
			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/content',
				headers: headers(),
				payload: { collectionId: collection.id, metadata: { title: 'Fresh', views: '' } },
			})
			expect(res.statusCode).toBe(201)
			const created = res.json()
			const row = await sourceRow(Number(created.externalId))
			expect(row.title).toBe('Fresh')
			expect(row.views).toBe(0)
		})
	},
)
