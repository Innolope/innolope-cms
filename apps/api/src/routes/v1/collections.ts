import type { CollectionField } from '@innolope/config'
import { collections, content, contentVersions, importJobs, projects } from '@innolope/db'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { createExternalDbAdapter } from '../../adapters/external-db.js'
import {
	loadMemberCollectionAccess,
	loadReferencedCollectionIds,
	loadRelationTargets,
} from '../../lib/collection-access.js'
import { getProject } from '../../plugins/project.js'
import { previewMarkdownCacheSync, syncMarkdownCache } from '../../services/markdown-cache.js'

function getExternalDbConfig(project: typeof projects.$inferSelect | undefined) {
	const extDb = (project?.settings as unknown as Record<string, unknown>)?.externalDb as
		| Record<string, unknown>
		| undefined
	if (!extDb?.type || !extDb?.connectionString) return null
	return {
		type: extDb.type as string,
		connectionString: extDb.connectionString as string,
		database: extDb.database as string | undefined,
	}
}

/**
 * Compute the id set to filter collection-list queries by, given the caller's role
 * and membership. Returns `null` when the caller should see every collection
 * (owner, admin, or unrestricted editor/viewer).
 */
async function resolveVisibleCollectionIds(
	app: FastifyInstance,
	request: import('fastify').FastifyRequest,
	includeReferenced: boolean,
): Promise<Set<string> | null> {
	const role = request.projectRole
	if (role === 'owner' || role === 'admin') return null
	if (!request.membershipId || !request.project) return null
	const access = await loadMemberCollectionAccess(app.db, request.membershipId)
	if (access.unrestricted) return null
	const ids = new Set(access.allowedIds)
	if (includeReferenced) {
		const refs = await loadReferencedCollectionIds(app.db, request.project.id, access.allowedIds)
		for (const id of refs) ids.add(id)
	}
	return ids
}

export async function collectionRoutes(app: FastifyInstance) {
	// List collections (viewer+, project-scoped).
	// The `media`-backed collection is an internal relation target — consumers fetch
	// assets via GET /api/v1/media, so it is excluded from this public list.
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = getProject(request).id
		const includeReferenced =
			(request.query as { include?: string } | undefined)?.include === 'referenced'
		const visibleIds = await resolveVisibleCollectionIds(app, request, includeReferenced)

		const baseConds = [eq(collections.projectId, pid), ne(collections.source, 'media')]
		if (visibleIds) {
			if (visibleIds.size === 0) return []
			baseConds.push(inArray(collections.id, Array.from(visibleIds)))
		}

		const rows = await app.db
			.select()
			.from(collections)
			.where(and(...baseConds))

		const targets = await loadRelationTargets(app.db, pid)
		return rows.map((r) => ({ ...r, isLinkedTarget: targets.byId.get(r.id) === true }))
	})

	// List collections with content counts (viewer+, project-scoped)
	app.get('/with-counts', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = getProject(request).id
		const includeReferenced =
			(request.query as { include?: string } | undefined)?.include === 'referenced'
		const visibleIds = await resolveVisibleCollectionIds(app, request, includeReferenced)

		const conds = [eq(collections.projectId, pid)]
		if (visibleIds) {
			if (visibleIds.size === 0) return []
			conds.push(inArray(collections.id, Array.from(visibleIds)))
		}

		const results = await app.db
			.select({
				id: collections.id,
				name: collections.name,
				label: collections.label,
				description: collections.description,
				fields: collections.fields,
				titleField: collections.titleField,
				source: collections.source,
				accessMode: collections.accessMode,
				sidebarMode: collections.sidebarMode,
				createdAt: collections.createdAt,
				contentCount: sql<number>`cast(count(${content.id}) as int)`,
			})
			.from(collections)
			.leftJoin(content, and(eq(content.collectionId, collections.id), eq(content.projectId, pid)))
			.where(and(...conds))
			.groupBy(collections.id)
			.orderBy(asc(collections.label))

		const targets = await loadRelationTargets(app.db, pid)
		return results.map((r) => ({ ...r, isLinkedTarget: targets.byId.get(r.id) === true }))
	})

	// Get collection by ID (viewer+, project-scoped)
	// UUID constraint prevents matching static routes like /with-counts
	app.get<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('viewer')], constraints: {} },
		async (request, reply) => {
			// Skip non-UUID params (handled by other routes)
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)
			) {
				return reply.status(404).send({ error: 'Collection not found' })
			}
			const [item] = await app.db
				.select()
				.from(collections)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Collection not found' })
			return item
		},
	)

	// Background-import status for a collection (viewer+, project-scoped).
	// Returns the latest import job, or null when none has ever been queued.
	app.get<{ Params: { id: string } }>(
		'/:id/import-status',
		{ preHandler: [app.requireProject('viewer')] },
		async (request) => {
			try {
				const [job] = await app.db
					.select({
						status: importJobs.status,
						processed: importJobs.processed,
						total: importJobs.total,
						error: importJobs.error,
						updatedAt: importJobs.updatedAt,
					})
					.from(importJobs)
					.where(
						and(
							eq(importJobs.collectionId, request.params.id),
							eq(importJobs.projectId, getProject(request).id),
						),
					)
					.orderBy(desc(importJobs.createdAt))
					.limit(1)
				return job ?? null
			} catch (err) {
				// `import_jobs` may be missing/unreadable — report "no job" instead of 500.
				app.log.warn(err, 'import-status query failed')
				return null
			}
		},
	)

	// Preview external source-of-truth changes before overwriting the local cache.
	app.get<{ Params: { id: string } }>(
		'/:id/sync-preview',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			const [collection] = await app.db
				.select()
				.from(collections)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)

			if (!collection) return reply.status(404).send({ error: 'Collection not found' })
			if (collection.source !== 'external' || !collection.externalTable) {
				return reply.status(400).send({ error: 'Collection is not backed by an external database' })
			}

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			const extDb = getExternalDbConfig(project)
			if (!extDb) return reply.status(400).send({ error: 'External database is not configured' })

			const adapter = createExternalDbAdapter(extDb)
			await adapter.connect()
			try {
				return await previewMarkdownCacheSync(app.db, content, adapter, {
					id: collection.id,
					projectId: collection.projectId,
					externalTable: collection.externalTable,
					fields: collection.fields,
					cursorColumn: collection.cursorColumn,
					lastSyncedCursor: collection.lastSyncedCursor,
				})
			} finally {
				await adapter.disconnect()
			}
		},
	)

	// Refresh local content cache from the external source of truth (editor+, project-scoped)
	app.post<{ Params: { id: string } }>(
		'/:id/sync',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			const [collection] = await app.db
				.select()
				.from(collections)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)

			if (!collection) return reply.status(404).send({ error: 'Collection not found' })
			if (collection.source !== 'external' || !collection.externalTable) {
				return reply.status(400).send({ error: 'Collection is not backed by an external database' })
			}

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			const extDb = getExternalDbConfig(project)
			if (!extDb) return reply.status(400).send({ error: 'External database is not configured' })

			const adapter = createExternalDbAdapter(extDb)
			await adapter.connect()
			try {
				const result = await syncMarkdownCache(
					app.db,
					content,
					adapter,
					{
						id: collection.id,
						projectId: collection.projectId,
						externalTable: collection.externalTable,
						fields: collection.fields,
						cursorColumn: collection.cursorColumn,
						lastSyncedCursor: collection.lastSyncedCursor,
					},
					{
						userId: request.user?.id,
						versionTable: contentVersions,
						collectionsTable: collections,
					},
				)
				return result
			} finally {
				await adapter.disconnect()
			}
		},
	)

	// Create collection (admin+, project-scoped)
	app.post('/', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const { name, label, description, fields, titleField, sidebarMode } = request.body as {
			name: string
			label: string
			description?: string
			fields?: unknown[]
			titleField?: string | null
			sidebarMode?: 'auto' | 'show' | 'hide'
		}

		if (name === 'media') {
			return reply
				.status(400)
				.send({ error: 'The "media" collection name is reserved by the system' })
		}

		const [created] = await app.db
			.insert(collections)
			.values({
				projectId: getProject(request).id,
				name,
				label,
				description,
				fields: (fields || []) as CollectionField[],
				titleField: titleField ?? null,
				...(sidebarMode ? { sidebarMode } : {}),
			})
			.returning()

		return reply.status(201).send(created)
	})

	// Update collection (admin+, project-scoped)
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { name, label, description, fields, titleField, sidebarMode } = request.body as {
				name?: string
				label?: string
				description?: string
				fields?: unknown[]
				titleField?: string | null
				sidebarMode?: 'auto' | 'show' | 'hide'
			}

			const [existing] = await app.db
				.select({ source: collections.source })
				.from(collections)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)

			if (!existing) return reply.status(404).send({ error: 'Collection not found' })
			if (existing.source === 'media') {
				return reply
					.status(400)
					.send({ error: 'The Media collection is managed by the system and cannot be modified' })
			}

			const updates: Record<string, unknown> = { updatedAt: new Date() }
			if (name !== undefined) updates.name = name
			if (label !== undefined) updates.label = label
			if (description !== undefined) updates.description = description
			if (fields !== undefined) updates.fields = fields
			if (titleField !== undefined) updates.titleField = titleField
			if (sidebarMode !== undefined) updates.sidebarMode = sidebarMode

			const [updated] = await app.db
				.update(collections)
				.set(updates)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.returning()

			if (!updated) return reply.status(404).send({ error: 'Collection not found' })
			return updated
		},
	)

	// Delete collection (admin+, project-scoped)
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const [existing] = await app.db
				.select({ source: collections.source })
				.from(collections)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)

			if (!existing) return reply.status(404).send({ error: 'Collection not found' })
			if (existing.source === 'media') {
				return reply
					.status(400)
					.send({ error: 'The Media collection is managed by the system and cannot be deleted' })
			}

			await app.db
				.delete(collections)
				.where(
					and(
						eq(collections.id, request.params.id),
						eq(collections.projectId, getProject(request).id),
					),
				)
			return reply.status(204).send()
		},
	)
}
