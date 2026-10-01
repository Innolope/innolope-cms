import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	externalSyncState,
	importJobs,
	projectMemberCollections,
	projectMembers,
	projects,
	users,
} from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createJwt } from '../plugins/auth.js'
import {
	syncExternalCollection,
	syncExternalCollections,
} from '../services/external-sync-worker.js'
import { syncState } from '../services/sync-state.js'
import { buildTestApp, hasTestDb } from '../test/harness.js'

const source = vi.hoisted(() => ({
	docs: new Map<string, Array<Record<string, unknown>>>(),
	failure: false,
	onRead: undefined as (() => Promise<void>) | undefined,
	connect: vi.fn(),
	disconnect: vi.fn(),
}))
vi.mock('../adapters/external-db.js', () => ({
	createExternalDbAdapter: () => ({
		connect: async () => {
			source.connect()
			if (source.failure) throw new Error('Synthetic connection failure')
		},
		disconnect: async () => {
			source.disconnect()
		},
		findAll: async (table: string) => {
			const observed = source.docs.get(table) ?? []
			await source.onRead?.()
			return observed
		},
	}),
}))
const config = { type: 'mongodb', connectionString: 'mongodb://synthetic.example.test' }

describe.skipIf(!hasTestDb)(
	'automatic external sync persistence and access (real Postgres)',
	() => {
		let app: FastifyInstance
		let projectId: string
		let ownerId: string
		let viewerId: string
		let token: string
		let viewerToken: string
		let col: typeof collections.$inferSelect
		let readonlyCol: typeof collections.$inferSelect
		let importingCol: typeof collections.$inferSelect
		let internalCol: typeof collections.$inferSelect
		let foreignCol: typeof collections.$inferSelect
		let foreignProjectId: string
		const as = (jwt = token) => ({ authorization: `Bearer ${jwt}`, 'x-project-id': projectId })
		beforeAll(async () => {
			app = await buildTestApp()
			const short = randomUUID().slice(0, 8)
			const [owner] = await app.db
				.insert(users)
				.values({ email: `worker-${short}@example.test`, name: 'Worker owner' })
				.returning()
			const [viewer] = await app.db
				.insert(users)
				.values({ email: `worker-viewer-${short}@example.test`, name: 'Viewer' })
				.returning()
			ownerId = owner.id
			viewerId = viewer.id
			const [project] = await app.db
				.insert(projects)
				.values({
					ownerId,
					name: 'Worker test',
					slug: `worker-${short}`,
					settings: { externalDb: config },
				})
				.returning()
			projectId = project.id
			await app.db.insert(projectMembers).values({ projectId, userId: ownerId, role: 'owner' })
			const [viewerMember] = await app.db
				.insert(projectMembers)
				.values({ projectId, userId: viewerId, role: 'viewer' })
				.returning()
			const makeCol = async (
				name: string,
				accessMode = 'read-write',
				sourceType = 'external',
				pid = projectId,
			) => {
				const [row] = await app.db
					.insert(collections)
					.values({
						projectId: pid,
						name: `${name}_${short}`,
						label: name,
						source: sourceType,
						accessMode,
						externalTable: `${name}_${short}`,
						fields: [
							{ name: 'title', type: 'text' },
							{ name: 'content', type: 'text' },
						],
					})
					.returning()
				return row
			}
			col = await makeCol('editable')
			readonlyCol = await makeCol('readonly', 'read-only')
			importingCol = await makeCol('importing')
			internalCol = await makeCol('internal', 'read-write', 'internal')
			await app.db
				.insert(projectMemberCollections)
				.values({ memberId: viewerMember.id, collectionId: internalCol.id })
			const [foreign] = await app.db
				.insert(projects)
				.values({ ownerId, name: 'Foreign worker test', slug: `foreign-worker-${short}` })
				.returning()
			foreignProjectId = foreign.id
			foreignCol = await makeCol('foreign', 'read-write', 'external', foreign.id)
			token = await createJwt({ id: ownerId, email: owner.email, name: owner.name, role: 'editor' })
			viewerToken = await createJwt({
				id: viewerId,
				email: viewer.email,
				name: viewer.name,
				role: 'editor',
			})
		})
		afterAll(async () => {
			source.failure = false
			if (projectId) await app.db.delete(projects).where(eq(projects.id, projectId))
			if (foreignProjectId) await app.db.delete(projects).where(eq(projects.id, foreignProjectId))
			if (ownerId) await app.db.delete(users).where(eq(users.id, ownerId))
			if (viewerId) await app.db.delete(users).where(eq(users.id, viewerId))
			await app?.close()
		})
		const currentRow = async () =>
			(await app.db.select().from(content).where(eq(content.collectionId, col.id)))[0]

		it('imports incoming changes, preserves conflicts across runs and exposes friendly choices', async () => {
			source.docs.set(col.externalTable ?? '', [
				{ _id: 'one', title: 'Original', content: 'Body', views: 1 },
			])
			await syncExternalCollection(app, col, config, { background: true })
			const original = await currentRow()
			// A clean incoming update is applied automatically.
			source.docs.set(col.externalTable ?? '', [
				{ _id: 'one', title: 'Incoming', content: 'Body', views: 1 },
			])
			await app.db
				.update(externalSyncState)
				.set({ nextAttemptAt: new Date(0) })
				.where(eq(externalSyncState.collectionId, col.id))
			const clean = await syncExternalCollection(app, col, config, { background: true })
			expect(clean?.conflicts).toEqual([])
			expect((await currentRow()).metadata.title).toBe('Incoming')
			// CMS and source now change the same title independently.
			await app.db
				.update(content)
				.set({ metadata: { ...original.metadata, title: 'CMS draft' }, version: 3 })
				.where(eq(content.id, original.id))
			source.docs.set(col.externalTable ?? '', [
				{ _id: 'one', title: 'External draft', content: 'Body', views: 1 },
			])
			const conflict = await syncExternalCollection(app, col, config)
			expect(conflict?.conflicts).toHaveLength(1)
			expect((await currentRow()).metadata.title).toBe('CMS draft')
			const status = await app.inject({
				method: 'GET',
				url: `/api/v1/collections/${col.id}/sync-status?contentId=${original.id}`,
				headers: as(),
			})
			expect(status.statusCode).toBe(200)
			expect(status.json().conflicts[0].metadata.title).toBe('CMS draft')
			expect(status.json()).toMatchObject({ enabled: true, intervalMs: 10000 })
			const otherRecord = await app.inject({
				method: 'GET',
				url: `/api/v1/collections/${col.id}/sync-status?contentId=${randomUUID()}`,
				headers: as(),
			})
			expect(otherRecord.json().conflicts).toEqual([])
			// Repeated unattended scans leave the record untouched.
			await syncExternalCollection(app, col, config)
			expect((await currentRow()).metadata.title).toBe('CMS draft')
			const choice = conflict?.conflicts[0]
			if (!choice) throw new Error('Expected a conflict for review')
			const resolved = await app.inject({
				method: 'POST',
				url: `/api/v1/collections/${col.id}/sync`,
				headers: as(),
				payload: { resolutions: { [original.id]: { token: choice.token, choice: 'external' } } },
			})
			expect(resolved.statusCode).toBe(200)
			expect(resolved.json().conflicts).toEqual([])
			expect((await currentRow()).metadata.title).toBe('External draft')
			expect(
				(
					await app.db
						.select()
						.from(externalSyncState)
						.where(eq(externalSyncState.collectionId, col.id))
				)[0].conflicts,
			).toEqual([])
		})

		it('does not change edit timestamps on repeat scans after keeping CMS edits', async () => {
			const current = await currentRow()
			await app.db
				.update(content)
				.set({
					metadata: { ...current.metadata, title: 'Keep CMS' },
					version: current.version + 1,
					updatedAt: new Date(),
				})
				.where(eq(content.id, current.id))
			source.docs.set(col.externalTable ?? '', [
				{ _id: 'one', title: 'Other source', content: 'Body', views: 1 },
			])
			const conflict = await syncExternalCollection(app, col, config)
			const choice = conflict?.conflicts[0]
			if (!choice) throw new Error('Expected a conflict')
			await syncExternalCollection(app, col, config, {
				resolutions: { [current.id]: { token: choice.token, choice: 'local' } },
			})
			const reviewed = await currentRow()
			await app.db
				.update(externalSyncState)
				.set({ nextAttemptAt: new Date(0) })
				.where(eq(externalSyncState.collectionId, col.id))
			const repeat = await syncExternalCollection(app, col, config, { background: true })
			expect(repeat?.conflicts).toEqual([])
			const unchanged = await currentRow()
			expect(unchanged.metadata.title).toBe('Keep CMS')
			expect(unchanged.version).toBe(reviewed.version)
			expect(unchanged.updatedAt.toISOString()).toBe(reviewed.updatedAt.toISOString())
		})

		it('defers a write-through CMS save made while the source scan was in flight', async () => {
			const before = await currentRow()
			source.docs.set(col.externalTable ?? '', [
				{ _id: 'one', title: 'Stale source read', content: 'Body', views: 1 },
			])
			source.onRead = async () => {
				source.onRead = undefined
				const fresh = { ...before.metadata, title: 'Fresh CMS save' }
				await app.db
					.update(content)
					.set({
						metadata: fresh,
						externalSnapshot: syncState({ ...before, metadata: fresh }),
						version: before.version + 1,
						updatedBy: ownerId,
						updatedSource: 'admin',
						updatedAt: new Date(),
					})
					.where(eq(content.id, before.id))
				source.docs.set(col.externalTable ?? '', [
					{ _id: 'one', title: 'Fresh CMS save', content: 'Body', views: 1 },
				])
			}
			let result: Awaited<ReturnType<typeof syncExternalCollection>>
			try {
				result = await syncExternalCollection(app, col, config)
			} finally {
				source.onRead = undefined
			}
			expect(result?.deferred).toBe(1)
			expect((await currentRow()).metadata.title).toBe('Fresh CMS save')
			const next = await syncExternalCollection(app, col, config)
			expect(next?.deferred).toBe(0)
			expect(next?.conflicts).toEqual([])
			expect((await currentRow()).metadata.title).toBe('Fresh CMS save')
		})

		it('claims a collection only once across concurrent runs, and recovers expired leases', async () => {
			const results = await Promise.all([
				syncExternalCollection(app, col, config, { background: true }),
				syncExternalCollection(app, col, config, { background: true }),
			])
			expect(results).toEqual([null, null]) // previous scan just ran; it is not due
			await app.db
				.update(externalSyncState)
				.set({ nextAttemptAt: new Date(0), leaseToken: randomUUID(), leaseUntil: new Date(0) })
				.where(eq(externalSyncState.collectionId, col.id))
			const raced = await Promise.all([
				syncExternalCollection(app, col, config, { background: true }),
				syncExternalCollection(app, col, config, { background: true }),
			])
			expect(raced.filter(Boolean)).toHaveLength(1)
			const [state] = await app.db
				.select()
				.from(externalSyncState)
				.where(eq(externalSyncState.collectionId, col.id))
			expect(state.leaseToken).toBeNull()
			expect(state.leaseUntil).toBeNull()
		})

		it('manual sync respects an active background lease', async () => {
			await app.db
				.update(externalSyncState)
				.set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 90000) })
				.where(eq(externalSyncState.collectionId, col.id))
			const response = await app.inject({
				method: 'POST',
				url: `/api/v1/collections/${col.id}/sync`,
				headers: as(),
				payload: {},
			})
			expect(response.statusCode).toBe(409)
			expect(response.json().code).toBe('SYNC_BUSY')
			await app.db
				.update(externalSyncState)
				.set({ leaseToken: null, leaseUntil: null })
				.where(eq(externalSyncState.collectionId, col.id))
		})

		it('releases a failed connection, backs off and clears its error after recovery', async () => {
			source.failure = true
			const disconnected = source.disconnect.mock.calls.length
			try {
				await expect(syncExternalCollection(app, col, config)).rejects.toThrow(
					'Synthetic connection failure',
				)
			} finally {
				source.failure = false
			}
			expect(source.disconnect.mock.calls.length).toBe(disconnected + 1)
			let [state] = await app.db
				.select()
				.from(externalSyncState)
				.where(eq(externalSyncState.collectionId, col.id))
			expect(state.leaseToken).toBeNull()
			expect(state.lastError).toContain('retry automatically')
			expect(state.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
			await syncExternalCollection(app, col, config)
			;[state] = await app.db
				.select()
				.from(externalSyncState)
				.where(eq(externalSyncState.collectionId, col.id))
			expect(state.lastError).toBeNull()
			expect(state.failureCount).toBe(0)
		})

		it('syncs read-only sources while skipping initial imports and internal collections', async () => {
			source.docs.set(readonlyCol.externalTable ?? '', [
				{ _id: 'readonly', title: 'Read-only incoming' },
			])
			source.docs.set(importingCol.externalTable ?? '', [
				{ _id: 'importing', title: 'Waiting for initial import' },
			])
			await app.db.insert(importJobs).values({
				projectId,
				collectionId: importingCol.id,
				externalTable: importingCol.externalTable ?? '',
				status: 'pending',
				createdBy: ownerId,
			})
			await syncExternalCollections(app)
			expect(
				await app.db.select().from(content).where(eq(content.collectionId, readonlyCol.id)),
			).toHaveLength(1)
			expect(
				await app.db
					.select()
					.from(externalSyncState)
					.where(eq(externalSyncState.collectionId, importingCol.id)),
			).toHaveLength(0)
			expect(
				await app.db
					.select()
					.from(externalSyncState)
					.where(eq(externalSyncState.collectionId, internalCol.id)),
			).toHaveLength(0)
			await app.db.delete(importJobs).where(eq(importJobs.collectionId, importingCol.id))
		})

		it('keeps sync conflicts within project and collection access boundaries', async () => {
			const forbidden = await app.inject({
				method: 'GET',
				url: `/api/v1/collections/${col.id}/sync-status`,
				headers: as(viewerToken),
			})
			expect(forbidden.statusCode).toBe(403)
			const foreign = await app.inject({
				method: 'GET',
				url: `/api/v1/collections/${foreignCol.id}/sync-status`,
				headers: as(),
			})
			expect(foreign.statusCode).toBe(404)
		})
	},
)
