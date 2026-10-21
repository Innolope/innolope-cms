import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	contentVersions,
	externalSyncState,
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
import { buildCollectionFields } from '../services/collection-schema.js'
import { checkSourceSchemaDrift } from '../services/external-schema.js'
import { syncMarkdownCache } from '../services/markdown-cache.js'
import { buildTestApp, hasTestDb, TEST_DB_URL } from '../test/harness.js'

/**
 * The recorded source schema at work against a real PostgreSQL source: native
 * types, composite keys, preflight refusals and drift detection.
 */
describe.skipIf(!hasTestDb)(
	'source schema and codec (real Postgres source)',
	{ timeout: 30_000 },
	() => {
		let app: FastifyInstance
		let source: postgres.Sql
		let projectId: string
		let userId: string
		let token: string
		const short = randomUUID().slice(0, 8)
		const products = `ext_products_${short}`
		const pages = `ext_pages_${short}`
		const SOURCE_URL = TEST_DB_URL ?? ''
		const collectionsByTable = new Map<string, typeof collections.$inferSelect>()

		const headers = () => ({ authorization: `Bearer ${token}`, 'x-project-id': projectId })
		const adapter = () =>
			createExternalDbAdapter({ type: 'postgresql', connectionString: SOURCE_URL })

		/** Import a table the way the wizard does: describe it, build fields, cache rows. */
		async function importTable(table: string) {
			const describer = adapter()
			await describer.connect()
			try {
				const schema = await describer.describeTable(table)
				const fields = buildCollectionFields(
					(schema.columns ?? []).map((column) => ({ name: column.name, type: column.nativeType })),
					{ sourceSchema: schema },
				)
				const [col] = await app.db
					.insert(collections)
					.values({
						projectId,
						name: table,
						label: table,
						source: 'external',
						externalTable: table,
						accessMode: 'read-write',
						fields,
						sourceSchema: schema,
						sourceSchemaHash: schema.hash,
					})
					.returning()
				await syncMarkdownCache(app.db, content, describer, col as never, {
					versionTable: contentVersions,
				})
				collectionsByTable.set(table, col)
				return col
			} finally {
				await describer.disconnect()
			}
		}

		async function cached(table: string, externalId: string) {
			const col = collectionsByTable.get(table)
			const [row] = await app.db
				.select()
				.from(content)
				.where(and(eq(content.collectionId, col?.id ?? ''), eq(content.externalId, externalId)))
			return row
		}

		beforeAll(async () => {
			app = await buildTestApp()
			source = postgres(SOURCE_URL, { onnotice: () => {} })
			await source.unsafe(`
			DO $$ BEGIN CREATE TYPE ext_mood_${short} AS ENUM ('happy', 'sad'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
			CREATE TABLE ${products} (
				tenant text NOT NULL,
				sku text NOT NULL,
				title text NOT NULL,
				price numeric(20,6),
				stock bigint,
				mood ext_mood_${short},
				code varchar(3),
				tags jsonb,
				total numeric GENERATED ALWAYS AS (price * 2) STORED,
				PRIMARY KEY (tenant, sku)
			);
			CREATE TABLE ${pages} (id serial PRIMARY KEY, title text NOT NULL);
		`)
			await source`INSERT INTO ${source(products)} ${source({ tenant: 'acme', sku: 'A-1', title: 'Widget', price: '1.000000', stock: '9007199254740993', tags: source.json(['a']) })}`
			await source`INSERT INTO ${source(pages)} ${source({ title: 'Home' })}`

			const [user] = await app.db
				.insert(users)
				.values({ email: `codec-${short}@example.com`, name: 'Codec', role: 'editor' })
				.returning()
			userId = user.id
			const [project] = await app.db
				.insert(projects)
				.values({
					name: 'Codec',
					slug: `codec-${short}`,
					ownerId: userId,
					settings: {
						externalDb: {
							type: 'postgresql',
							connectionString: SOURCE_URL,
							accessMode: 'read-write',
						},
					} as never,
				})
				.returning()
			projectId = project.id
			await app.db.insert(projectMembers).values({ projectId, userId, role: 'owner' })
			token = await createJwt({ id: userId, email: user.email, name: 'Codec', role: 'editor' })
			await importTable(products)
			await importTable(pages)
		})

		afterAll(async () => {
			if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
			if (userId) await app.db.delete(users).where(eq(users.id, userId))
			if (source) {
				await source.unsafe(
					`DROP TABLE IF EXISTS ${products}; DROP TABLE IF EXISTS ${pages}; DROP TYPE IF EXISTS ext_mood_${short};`,
				)
				await source.end()
			}
			await app?.close()
		})

		it('learns enums, generated columns and the composite key from the source', () => {
			const col = collectionsByTable.get(products)
			const byName = new Map((col?.fields ?? []).map((f) => [f.name, f]))
			expect(byName.get('mood')).toMatchObject({ type: 'enum', options: ['happy', 'sad'] })
			expect(byName.get('total')?.ui?.readOnly).toBe(true)
			expect(col?.sourceSchema?.primaryKey).toEqual(['tenant', 'sku'])
		})

		it('caches a composite-key row under a JSON-array external id and writes back to it', async () => {
			const row = await cached(products, '["acme","A-1"]')
			expect(row).toBeTruthy()
			const res = await app.inject({
				method: 'PUT',
				url: `/api/v1/content/${row.id}`,
				headers: headers(),
				payload: { metadata: { title: 'Widget Pro' } },
			})
			expect(res.statusCode).toBe(200)
			const [source_row] =
				await source`SELECT * FROM ${source(products)} WHERE tenant = 'acme' AND sku = 'A-1'`
			expect(source_row.title).toBe('Widget Pro')
		})

		it('keeps exact numerics exact through the cache and back', async () => {
			const row = await cached(products, '["acme","A-1"]')
			expect((row.metadata as Record<string, unknown>).stock).toBe('9007199254740993')
			const res = await app.inject({
				method: 'PUT',
				url: `/api/v1/content/${row.id}`,
				headers: headers(),
				payload: { metadata: { price: '12345678901234.123456' } },
			})
			expect(res.statusCode).toBe(200)
			const [source_row] =
				await source`SELECT price::text, stock::text FROM ${source(products)} WHERE sku = 'A-1'`
			expect(source_row.price).toBe('12345678901234.123456')
			expect(source_row.stock).toBe('9007199254740993')
		})

		it('refuses a value outside the native enum before touching the source', async () => {
			const row = await cached(products, '["acme","A-1"]')
			const res = await app.inject({
				method: 'PUT',
				url: `/api/v1/content/${row.id}`,
				headers: headers(),
				payload: { metadata: { code: 'TOOLONG' } },
			})
			expect(res.statusCode).toBe(400)
			expect(res.json().issues[0]).toMatchObject({ path: 'metadata.code' })
		})

		it('requires a NOT NULL column on insert, naming it', async () => {
			const col = collectionsByTable.get(pages)
			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/content',
				headers: headers(),
				payload: { collectionId: col?.id, metadata: {} },
			})
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: 'EXTERNAL_REQUIRED' })
			expect(res.json().issues[0].path).toBe('metadata.title')
		})

		it('refuses to connect Firestore, which nothing can import from or write to', async () => {
			const res = await app.inject({
				method: 'PUT',
				url: `/api/v1/projects/${projectId}/database`,
				headers: headers(),
				payload: { type: 'firebase', connectionString: '{}', tables: [] },
			})
			expect(res.statusCode).toBe(400)
			expect(res.json().error).toContain('Firestore')
		})

		it('detects drift on the sync pass and re-learns the fields when an admin updates them', async () => {
			const col = collectionsByTable.get(pages)
			if (!col) throw new Error('pages collection missing')
			await source`ALTER TABLE ${source(pages)} ADD COLUMN subtitle text`
			await app.db.insert(externalSyncState).values({ collectionId: col.id }).onConflictDoNothing()
			const describer = adapter()
			await describer.connect()
			try {
				const drift = await checkSourceSchemaDrift(app.db, col, describer)
				expect(drift?.added).toEqual(['subtitle'])
			} finally {
				await describer.disconnect()
			}
			const status = await app.inject({
				method: 'GET',
				url: `/api/v1/collections/${col.id}/sync-status`,
				headers: headers(),
			})
			expect(status.json().schemaDrift.added).toEqual(['subtitle'])

			const rescan = await app.inject({
				method: 'POST',
				url: `/api/v1/collections/${col.id}/rescan`,
				headers: headers(),
				payload: {},
			})
			expect(rescan.statusCode).toBe(200)
			expect(rescan.json().fields.map((f: { name: string }) => f.name)).toContain('subtitle')
			const after = await app.inject({
				method: 'GET',
				url: `/api/v1/collections/${col.id}/sync-status`,
				headers: headers(),
			})
			expect(after.json().schemaDrift).toBeNull()
		})
	},
)
