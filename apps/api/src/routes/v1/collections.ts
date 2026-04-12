import { collections, content } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql, asc } from 'drizzle-orm'

export async function collectionRoutes(app: FastifyInstance) {
	// List collections (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db.select().from(collections).where(eq(collections.projectId, request.project!.id))
	})

	// List collections with content counts (viewer+, project-scoped)
	app.get('/with-counts', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = request.project!.id
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
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)) {
				return reply.status(404).send({ error: 'Collection not found' })
			}
			const [item] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, request.params.id), eq(collections.projectId, request.project!.id)))
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Collection not found' })
			return item
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

		const [created] = await app.db
			.insert(collections)
			.values({
				projectId: request.project!.id,
				name,
				label,
				description,
				fields: (fields || []) as any,
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

			const updates: Record<string, unknown> = { updatedAt: new Date() }
			if (name !== undefined) updates.name = name
			if (label !== undefined) updates.label = label
			if (description !== undefined) updates.description = description
			if (fields !== undefined) updates.fields = fields

			const [updated] = await app.db
				.update(collections)
				.set(updates)
				.where(and(eq(collections.id, request.params.id), eq(collections.projectId, request.project!.id)))
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
			await app.db.delete(collections).where(
				and(eq(collections.id, request.params.id), eq(collections.projectId, request.project!.id)),
			)
			return reply.status(204).send()
		},
	)
}
