import { randomUUID } from 'node:crypto'
import { collections, content, contentVersions, projects, users } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExternalDbAdapter, ExternalDocument } from '../adapters/external-db.js'
import { syncMarkdownCache } from '../services/markdown-cache.js'
import { syncState } from '../services/sync-state.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

describe.skipIf(!hasTestDb)('external sync persistence (real Postgres)', () => {
	let app: FastifyInstance
	let projectId: string
	let collection: typeof collections.$inferSelect
	beforeAll(async () => {
		app = await buildTestApp()
		const short = randomUUID().slice(0, 8)
		const [user] = await app.db
			.insert(users)
			.values({ email: `sync-${short}@example.com`, name: 'Sync' })
			.returning()
		const [project] = await app.db
			.insert(projects)
			.values({ name: 'Sync test', slug: `sync-${short}`, ownerId: user.id })
			.returning()
		projectId = project.id
		;[collection] = await app.db
			.insert(collections)
			.values({
				projectId,
				name: `sync_${short}`,
				label: 'Sync',
				source: 'external',
				externalTable: 'articles',
				fields: [
					{ name: 'title', type: 'text' },
					{ name: 'content', type: 'text' },
				],
			})
			.returning()
	})
	afterAll(async () => {
		if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
		await app?.close()
	})
	const adapter = (docs: ExternalDocument[]) =>
		({
			findAll: vi.fn().mockResolvedValueOnce(docs).mockResolvedValue([]),
		}) as unknown as ExternalDbAdapter
	const sync = (
		docs: ExternalDocument[],
		resolutions?: Record<string, { token: string; choice: 'local' | 'external' }>,
	) =>
		syncMarkdownCache(
			app.db,
			content,
			adapter(docs),
			{ ...collection, externalTable: 'articles' },
			{ versionTable: contentVersions, collectionsTable: collections, resolutions },
		)
	const row = async (id: string) =>
		(await app.db.select().from(content).where(eq(content.externalId, id)))[0]

	it('silently refreshes cache-only updates, establishes a baseline and archives the old content', async () => {
		const id = randomUUID()
		await sync([{ _id: id, title: 'Original', content: 'Body' }])
		const result = await sync([{ _id: id, title: 'Incoming', content: 'Body' }])
		expect(result.conflicts).toEqual([])
		expect(result.updated).toBe(1)
		const current = await row(id)
		expect(current.metadata.title).toBe('Incoming')
		expect(current.externalSnapshot).toEqual(syncState(current))
		const versions = await app.db
			.select()
			.from(contentVersions)
			.where(eq(contentVersions.contentId, current.id))
		expect(versions[0].metadata.title).toBe('Original')
	})
	it('preserves a local edit while applying an unrelated incoming change', async () => {
		const id = randomUUID()
		await sync([{ _id: id, title: 'Original', content: 'Body', views: 1 }])
		const original = await row(id)
		await app.db
			.update(content)
			.set({
				metadata: { ...original.metadata, title: 'CMS title' },
				version: 2,
				updatedSource: 'admin',
			})
			.where(eq(content.id, original.id))
		const result = await sync([{ _id: id, title: 'Original', content: 'Body', views: 2 }])
		expect(result.conflicts).toEqual([])
		expect((await row(id)).metadata).toMatchObject({ title: 'CMS title', views: 2 })
	})
	it('protects conflicts, rejects stale choices and resolves only the reviewed content', async () => {
		const id = randomUUID()
		await sync([{ _id: id, title: 'Original', content: 'Body' }])
		const original = await row(id)
		await app.db
			.update(content)
			.set({
				metadata: { ...original.metadata, title: 'CMS title' },
				version: 2,
				updatedSource: 'admin',
			})
			.where(eq(content.id, original.id))
		const incoming = [{ _id: id, title: 'External title', content: 'Body' }]
		const first = await sync(incoming)
		expect(first.conflicts).toHaveLength(1)
		expect((await row(id)).metadata.title).toBe('CMS title')
		expect((await row(id)).version).toBe(2)
		const stale = {
			[original.id]: { token: first.conflicts[0].token, choice: 'external' as const },
		}
		const newer = [{ _id: id, title: 'Newer external title', content: 'Body' }]
		const retried = await sync(newer, stale)
		expect(retried.conflicts).toHaveLength(1)
		expect((await row(id)).metadata.title).toBe('CMS title')
		const resolved = await sync(newer, {
			[original.id]: { token: retried.conflicts[0].token, choice: 'external' },
		})
		expect(resolved.conflicts).toEqual([])
		expect((await row(id)).metadata.title).toBe('Newer external title')
	})
	it('merges legacy local-only edits using history instead of replacing them', async () => {
		const id = randomUUID()
		await sync([{ _id: id, title: 'Original', content: 'Body', views: 1 }])
		const original = await row(id)
		await app.db.insert(contentVersions).values({
			contentId: original.id,
			version: 1,
			markdown: original.markdown,
			metadata: original.metadata,
		})
		await app.db
			.update(content)
			.set({
				externalSnapshot: null,
				metadata: { ...original.metadata, title: 'CMS title' },
				version: 2,
				updatedSource: 'admin',
			})
			.where(eq(content.id, original.id))
		const result = await sync([{ _id: id, title: 'Original', content: 'Body', views: 2 }])
		expect(result.conflicts).toEqual([])
		expect((await row(id)).metadata).toMatchObject({ title: 'CMS title', views: 2 })
	})
	it('keeps CMS edits when requested and does not ask again for the same incoming version', async () => {
		const id = randomUUID()
		await sync([{ _id: id, title: 'Original', content: 'Body' }])
		const original = await row(id)
		await app.db
			.update(content)
			.set({ markdown: 'CMS body', version: 2 })
			.where(eq(content.id, original.id))
		const incoming = [{ _id: id, title: 'Original', content: 'External body' }]
		const first = await sync(incoming)
		await sync(incoming, { [original.id]: { token: first.conflicts[0].token, choice: 'local' } })
		expect((await row(id)).markdown).toBe('CMS body')
		expect((await sync(incoming)).conflicts).toEqual([])
	})
})
