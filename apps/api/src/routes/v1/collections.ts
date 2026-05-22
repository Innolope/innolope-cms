import type { CollectionField } from '@innolope/config'
import { collections, content, contentVersions, importJobs, projects } from '@innolope/db'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { createExternalDbAdapter } from '../../adapters/external-db.js'
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

export async function collectionRoutes(app: FastifyInstance) {
	// List collections (viewer+, project-scoped).
	// The `media`-backed collection is an internal relation target — consumers fetch
	// assets via GET /api/v1/media, so it is excluded from this public list.
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db
			.select()
			.from(collections)
			.where(
				and(eq(collections.projectId, getProject(request).id), ne(collections.source, 'media')),
			)
	})

	// List collections with content counts (viewer+, project-scoped)
	app.get('/with-counts', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = getProject(request).id
		const results = await app.db
			.select({
				id: collections.id,
				name: collections.name,
				label: collections.label,
				description: collections.description,
				fields: collections.fields,
				source: collections.source,
				accessMode: collections.accessMode,
				createdAt: collections.createdAt,
				contentCount: sql<number>`cast(count(${content.id}) as int)`,
			})
			.from(collections)
			.leftJoin(content, and(eq(content.collectionId, collections.id), eq(content.projectId, pid)))
			.where(eq(collections.projectId, pid))
			.groupBy(collections.id)
			.orderBy(asc(collections.label))
		return results
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
					},
					{ userId: request.user?.id, versionTable: contentVersions },
				)
				return result
			} finally {
				await adapter.disconnect()
			}
		},
	)

	// Create collection (admin+, project-scoped)
	app.post('/', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const { name, label, description, fields } = request.body as {
			name: string
			label: string
			description?: string
			fields?: unknown[]
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
			})
			.returning()

		return reply.status(201).send(created)
	})

	// Update collection (admin+, project-scoped)
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { name, label, description, fields } = request.body as {
				name?: string
				label?: string
				description?: string
				fields?: unknown[]
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
