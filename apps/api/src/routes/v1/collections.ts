import { collections } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'

export async function collectionRoutes(app: FastifyInstance) {
	// List collections (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db.select().from(collections).where(eq(collections.projectId, request.project!.id))
	})

	// Get collection by ID (viewer+, project-scoped)
	app.get<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
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
		const { name, slug, description, fields } = request.body as {
			name: string
			slug: string
			description?: string
			fields?: unknown[]
		}

		const [created] = await app.db
			.insert(collections)
			.values({
				projectId: request.project!.id,
				name,
				slug,
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
			const { name, slug, description, fields } = request.body as {
				name?: string
				slug?: string
				description?: string
				fields?: unknown[]
			}

			const updates: Record<string, unknown> = { updatedAt: new Date() }
			if (name !== undefined) updates.name = name
			if (slug !== undefined) updates.slug = slug
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
