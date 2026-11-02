import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	contentVersions,
	projectMemberCollections,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import { buildTestApp, hasTestDb, TEST_DB_URL } from '../test/harness.js'

describe.skipIf(!hasTestDb)(
	'agent hash breadth and faults (disposable Postgres)',
	{ timeout: 30_000 },
	() => {
		let app: Awaited<ReturnType<typeof buildTestApp>>
		let projectId: string
		let collectionId: string
		let restrictedCollectionId: string
		let externalCollectionId: string
		let source: postgres.Sql
		const table = `hash_source_${randomUUID().slice(0, 8)}`
		const ids: string[] = []
		const tokens: Record<string, string> = {}
		const headers = (role = 'admin') => ({
			authorization: `Bearer ${tokens[role]}`,
			'x-project-id': projectId,
			'x-innolope-client': 'mcp',
		})
		const read = async (id: string, depth = 0) => {
			const response = await app.inject({
				method: 'GET',
				url: `/api/v1/content/${id}?depth=${depth}`,
				headers: headers(),
			})
			expect(response.statusCode).toBe(200)
			return response.json()
		}
		const create = async (metadata: Record<string, unknown> = { title: 'Original' }) => {
			const response = await app.inject({
				method: 'POST',
				url: '/api/v1/content',
				headers: headers(),
				payload: { collectionId, slug: `hash-${randomUUID()}`, metadata, markdown: 'Original' },
			})
			expect(response.statusCode).toBe(201)
			return read(response.json().id)
		}
		const update = (record: { id: string; contentHash: string }, markdown: string) =>
			app.inject({
				method: 'PUT',
				url: `/api/v1/content/${record.id}`,
				headers: headers(),
				payload: { expectedHash: record.contentHash, markdown },
			})
		const batch = (records: Array<{ id: string; contentHash: string }>, markdown = 'Batch') =>
			app.inject({
				method: 'PUT',
				url: '/api/v1/content/bulk',
				headers: headers(),
				payload: {
					items: records.map((record) => ({
						id: record.id,
						expectedHash: record.contentHash,
						markdown,
					})),
				},
			})
		const history = (id: string) =>
			app.db.select().from(contentVersions).where(eq(contentVersions.contentId, id))
		beforeAll(async () => {
			app = await buildTestApp()
			for (const role of ['admin', 'editor', 'viewer']) {
				const [user] = await app.db
					.insert(users)
					.values({
						email: `hash-${role}-${randomUUID()}@example.test`,
						name: role,
						role: 'editor',
					})
					.returning()
				ids.push(user.id)
				tokens[role] = await createJwt({
					id: user.id,
					email: user.email,
					name: user.name,
					role: 'editor',
				})
			}
			const [project] = await app.db
				.insert(projects)
				.values({
					name: 'Hash breadth',
					slug: `hash-${randomUUID()}`,
					ownerId: ids[0],
					settings: {
						requireReview: true,
						externalDb: {
							type: 'postgresql',
							connectionString: TEST_DB_URL,
							accessMode: 'read-write',
						},
					} as never,
				})
				.returning()
			projectId = project.id
			for (const [index, role] of ['admin', 'editor', 'viewer'].entries())
				await app.db.insert(projectMembers).values({
					projectId,
					userId: ids[index],
					role: role as 'admin' | 'editor' | 'viewer',
					canPublishDirectly: role === 'admin',
				})
			const [collection] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: `hash_${randomUUID().replaceAll('-', '')}`,
					label: 'Hash',
					fields: [{ name: 'title', type: 'text' }],
				})
				.returning()
			collectionId = collection.id
			const [restricted] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: `restricted_${randomUUID().replaceAll('-', '')}`,
					label: 'Restricted',
					fields: [],
				})
				.returning()
			restrictedCollectionId = restricted.id
			const members = await app.db
				.select()
				.from(projectMembers)
				.where(eq(projectMembers.projectId, projectId))
			for (const member of members.filter((member) => member.role !== 'admin'))
				await app.db.insert(projectMemberCollections).values({ memberId: member.id, collectionId })
			source = postgres(TEST_DB_URL ?? '', { onnotice: () => {} })
			await source`CREATE TABLE ${source(table)} (id serial PRIMARY KEY, title text NOT NULL)`
			const [external] = await app.db
				.insert(collections)
				.values({
					projectId,
					name: table,
					label: 'External hash',
					source: 'external',
					externalTable: table,
					accessMode: 'read-write',
					fields: [{ name: 'title', type: 'text' }],
				})
				.returning()
			externalCollectionId = external.id
		})
		afterAll(async () => {
			if (app && projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
			if (app) for (const id of ids) await app.db.delete(users).where(eq(users.id, id))
			if (source) {
				await source`DROP TABLE IF EXISTS ${source(table)}`
				await source.end()
			}
			await app?.close()
		})
		it('admits one of 24 concurrent writers, with one history entry', async () => {
			const record = await create()
			const results = await Promise.all(
				Array.from({ length: 24 }, (_, index) => update(record, `Writer ${index}`)),
			)
			expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1)
			expect(results.filter((result) => result.statusCode === 409)).toHaveLength(23)
			expect(await history(record.id)).toHaveLength(1)
		})
		it('serializes overlapping batches submitted in reverse order without deadlock', async () => {
			const records = await Promise.all([create(), create()])
			const results = await Promise.all([
				batch(records, 'Forward'),
				batch([...records].reverse(), 'Reverse'),
			])
			expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409])
			for (const record of records) expect(await history(record.id)).toHaveLength(1)
		})
		it('serializes a bulk edit racing a single edit without partially applying the loser', async () => {
			const records = await Promise.all([create(), create()])
			const results = await Promise.all([batch(records), update(records[0], 'Single')])
			expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409])
			expect(await history(records[0].id)).toHaveLength(1)
			expect(await history(records[1].id)).toHaveLength(results[0].statusCode === 200 ? 1 : 0)
		})
		it('delete/edit races cannot delete a newly saved revision', async () => {
			const record = await create()
			const [edited, deleted] = await Promise.all([
				update(record, 'Kept'),
				app.inject({
					method: 'DELETE',
					url: `/api/v1/content/${record.id}?expectedHash=${record.contentHash}`,
					headers: headers(),
				}),
			])
			if (edited.statusCode === 200) {
				expect(deleted.statusCode).toBe(409)
				expect((await read(record.id)).markdown).toBe('Kept')
			} else {
				expect(edited.statusCode).toBe(404)
				expect(deleted.statusCode).toBe(204)
			}
		})
		it('checks status/revert hashes before effects and enforces a full review sequence', async () => {
			const record = await create()
			const post = (path: string, payload: Record<string, unknown>, role = 'admin') =>
				app.inject({
					method: 'POST',
					url: `/api/v1/content/${record.id}/${path}`,
					headers: headers(role),
					payload,
				})
			expect((await post('submit-for-review', {}, 'editor')).statusCode).toBe(428)
			const submitted = await post(
				'submit-for-review',
				{ expectedHash: record.contentHash },
				'editor',
			)
			expect(submitted.statusCode).toBe(200)
			for (const path of ['approve', 'reject', 'revert/1']) {
				expect((await post(path, {})).statusCode).toBe(428)
				expect((await post(path, { expectedHash: record.contentHash })).statusCode).toBe(409)
			}
			const rejected = await post('reject', { expectedHash: submitted.json().contentHash })
			expect(rejected.statusCode).toBe(200)
			const resubmitted = await post(
				'submit-for-review',
				{ expectedHash: rejected.json().contentHash },
				'editor',
			)
			expect(resubmitted.statusCode).toBe(200)
			const approved = await post('approve', { expectedHash: resubmitted.json().contentHash })
			expect(approved.statusCode).toBe(200)
			expect(approved.json().contentHash).not.toBe(resubmitted.json().contentHash)
			const reverted = await post('revert/1', { expectedHash: approved.json().contentHash })
			expect(reverted.statusCode).toBe(200)
			expect(reverted.json().contentHash).not.toBe(record.contentHash)
		})
		it('denies viewer writes and scoped editors before conflict details (including bulk dry-run)', async () => {
			const record = await create()
			const [restricted] = await app.db
				.insert(content)
				.values({ projectId, collectionId: restrictedCollectionId, markdown: 'Secret' })
				.returning()
			for (const response of [
				await app.inject({
					method: 'PUT',
					url: `/api/v1/content/${record.id}`,
					headers: headers('viewer'),
					payload: { expectedHash: record.contentHash, markdown: 'Denied' },
				}),
				await app.inject({
					method: 'PUT',
					url: `/api/v1/content/${restricted.id}`,
					headers: headers('editor'),
					payload: { expectedHash: `sha256:${'a'.repeat(64)}`, markdown: 'Denied' },
				}),
				await app.inject({
					method: 'PUT',
					url: '/api/v1/content/bulk',
					headers: headers('editor'),
					payload: {
						items: [
							{ id: restricted.id, expectedHash: `sha256:${'a'.repeat(64)}`, markdown: 'Denied' },
						],
						dryRun: true,
					},
				}),
			]) {
				expect(response.statusCode).toBe(403)
				expect(response.body).not.toContain('CONTENT_CONFLICT')
				expect(response.body).not.toContain('sha256:')
			}
		})
		it('uses the same hash for hydrated and raw relation representations', async () => {
			const target = await create()
			await app.db
				.update(collections)
				.set({
					fields: [
						{ name: 'title', type: 'text' },
						{
							name: 'related',
							type: 'relation',
							relationTo: (
								await app.db.select().from(collections).where(eq(collections.id, collectionId))
							)[0].name,
						},
					],
				})
				.where(eq(collections.id, collectionId))
			const record = await create({ title: 'With relation', related: target.id })
			expect((await read(record.id, 1)).contentHash).toBe(record.contentHash)
			expect((await update(record, 'Fresh after hydration')).statusCode).toBe(200)
		})
		it('stale external updates and uncached agent deletion leave the source untouched', async () => {
			const [sourceRecord] =
				await source`INSERT INTO ${source(table)} (title) VALUES ('Source original') RETURNING id`
			const [cached] = await app.db
				.insert(content)
				.values({
					projectId,
					collectionId: externalCollectionId,
					externalId: String(sourceRecord.id),
					metadata: { title: 'Source original' },
					markdown: '',
				})
				.returning()
			const record = await read(cached.id)
			await app.db
				.update(content)
				.set({ metadata: { title: 'Intervening' }, version: cached.version + 1 })
				.where(eq(content.id, cached.id))
			const stale = await app.inject({
				method: 'PUT',
				url: '/api/v1/content/bulk',
				headers: headers(),
				payload: {
					items: [
						{
							id: cached.id,
							expectedHash: record.contentHash,
							metadata: { title: 'Stale replacement' },
						},
					],
				},
			})
			expect(stale.statusCode).toBe(409)
			expect(
				(await source`SELECT title FROM ${source(table)} WHERE id=${sourceRecord.id}`)[0].title,
			).toBe('Source original')
			const [uncached] =
				await source`INSERT INTO ${source(table)} (title) VALUES ('Uncached') RETURNING id`
			const deleted = await app.inject({
				method: 'DELETE',
				url: `/api/v1/content/${uncached.id}?collectionId=${externalCollectionId}&expectedHash=${record.contentHash}`,
				headers: headers(),
			})
			expect(deleted.statusCode).toBe(409)
			expect(deleted.json().code).toBe('CONTENT_NOT_CACHED')
			expect(await source`SELECT id FROM ${source(table)} WHERE id=${uncached.id}`).toHaveLength(1)
		})
		it('compensates earlier external effects when a later source write fails', async () => {
			const [one, two] =
				await source`INSERT INTO ${source(table)} (title) VALUES ('Before one'), ('Before two') RETURNING id`
			const cached = await app.db
				.insert(content)
				.values(
					[one, two].map((row) => ({
						projectId,
						collectionId: externalCollectionId,
						externalId: String(row.id),
						metadata: { title: row.id === one.id ? 'Before one' : 'Before two' },
					})),
				)
				.returning()
			const records = await Promise.all(cached.map((row) => read(row.id)))
			const response = await app.inject({
				method: 'PUT',
				url: '/api/v1/content/bulk',
				headers: headers(),
				payload: {
					items: [
						{
							id: records[0].id,
							expectedHash: records[0].contentHash,
							metadata: { title: 'Changed first' },
						},
						{ id: records[1].id, expectedHash: records[1].contentHash, metadata: { title: null } },
					],
				},
			})
			expect(response.statusCode).toBe(400)
			expect((await source`SELECT title FROM ${source(table)} WHERE id=${one.id}`)[0].title).toBe(
				'Before one',
			)
			for (const record of records) {
				expect((await read(record.id)).contentHash).toBe(record.contentHash)
				expect(await history(record.id)).toHaveLength(0)
			}
		})
		it('restores provider fields after a CMS transaction rolls back its forward snapshot', async () => {
			const [one, two] =
				await source`INSERT INTO ${source(table)} (title) VALUES ('Rollback one'), ('Rollback two') RETURNING id`
			const cached = await app.db
				.insert(content)
				.values(
					[one, two].map((row) => ({
						projectId,
						collectionId: externalCollectionId,
						externalId: String(row.id),
						metadata: { title: row.id === one.id ? 'Rollback one' : 'Rollback two' },
						externalSnapshot: {
							status: 'draft',
							markdown: '',
							metadata: { title: row.id === one.id ? 'Rollback one' : 'Rollback two' },
						},
					})),
				)
				.returning()
			const records = await Promise.all(cached.map((row) => read(row.id)))
			const collision = await create()
			const response = await app.inject({
				method: 'PUT',
				url: '/api/v1/content/bulk',
				headers: headers(),
				payload: {
					items: [
						{
							id: records[0].id,
							expectedHash: records[0].contentHash,
							metadata: { title: 'Forward one' },
						},
						{
							id: records[1].id,
							expectedHash: records[1].contentHash,
							metadata: { title: 'Forward two' },
							slug: collision.slug,
						},
					],
				},
			})
			expect(response.statusCode).toBe(500)
			expect((await source`SELECT title FROM ${source(table)} WHERE id=${one.id}`)[0].title).toBe(
				'Rollback one',
			)
			expect((await source`SELECT title FROM ${source(table)} WHERE id=${two.id}`)[0].title).toBe(
				'Rollback two',
			)
			for (const record of records) {
				expect((await read(record.id)).contentHash).toBe(record.contentHash)
				expect(await history(record.id)).toHaveLength(0)
			}
		})
		it('fails closed on legacy auxiliary agent writes instead of bypassing reviewed hashes', async () => {
			const record = await create()
			const bulkAction = await app.inject({
				method: 'POST',
				url: '/api/v1/content/bulk-action',
				headers: headers(),
				payload: {
					action: 'set-field',
					ids: [record.id],
					field: 'title',
					value: 'Unchecked overwrite',
				},
			})
			expect(bulkAction.statusCode).toBe(428)
			expect(bulkAction.json().code).toBe('CONTENT_HASH_REQUIRED')
			expect((await read(record.id)).contentHash).toBe(record.contentHash)
			const cover = await app.inject({
				method: 'POST',
				url: '/api/v1/covers/generate',
				headers: headers(),
				payload: { contentId: record.id, field: 'image' },
			})
			expect(cover.statusCode).toBe(428)
			expect(cover.json().code).toBe('CONTENT_HASH_REQUIRED')
		})
		it('retains compensation receipts when provider success is followed by snapshot failure', async () => {
			const [row] =
				await source`INSERT INTO ${source(table)} (title) VALUES ('Before snapshot fault') RETURNING id`
			const [cached] = await app.db
				.insert(content)
				.values({
					projectId,
					collectionId: externalCollectionId,
					externalId: String(row.id),
					metadata: { title: 'Before snapshot fault' },
					externalSnapshot: {
						status: 'draft',
						markdown: '',
						metadata: { title: 'Before snapshot fault' },
					},
				})
				.returning()
			const record = await read(cached.id)
			const functionName = `${table}_snapshot_fn`
			const triggerName = `${table}_snapshot_guard`
			// Names and UUID are generated exclusively by this disposable fixture.
			await source.unsafe(
				`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."projectId"::text = '${projectId}' AND NEW."externalSnapshot"->'metadata'->>'title' = 'Snapshot forward' THEN RAISE EXCEPTION 'injected snapshot failure'; END IF; RETURN NEW; END $$`,
			)
			await source.unsafe(
				`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF "externalSnapshot" ON content FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
			)
			try {
				const response = await app.inject({
					method: 'PUT',
					url: '/api/v1/content/bulk',
					headers: headers(),
					payload: {
						items: [
							{
								id: record.id,
								expectedHash: record.contentHash,
								metadata: { title: 'Snapshot forward' },
							},
						],
					},
				})
				expect(response.statusCode).toBeGreaterThanOrEqual(500)
				expect((await source`SELECT title FROM ${source(table)} WHERE id=${row.id}`)[0].title).toBe(
					'Before snapshot fault',
				)
				expect((await read(record.id)).contentHash).toBe(record.contentHash)
				expect(await history(record.id)).toHaveLength(0)
			} finally {
				await source.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON content`)
				await source.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`)
			}
		})
	},
)
