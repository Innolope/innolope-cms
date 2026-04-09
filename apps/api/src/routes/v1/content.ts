import { content, contentVersions } from '@innolope/db'
import { contentInputSchema, contentListSchema } from '@innolope/config'
import type { FastifyInstance } from 'fastify'
import { eq, desc, asc, and, sql } from 'drizzle-orm'
import { marked } from 'marked'

export async function contentRoutes(app: FastifyInstance) {
	// List content (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const params = contentListSchema.parse(request.query)
		const { page, limit, sortBy, sortOrder, status, collectionId, locale, search } = params
		const offset = (page - 1) * limit
		const pid = request.project!.id

		const conditions = [eq(content.projectId, pid)]
		if (status) conditions.push(eq(content.status, status))
		if (collectionId) conditions.push(eq(content.collectionId, collectionId))
		if (locale) conditions.push(eq(content.locale, locale))
		if (search) {
			conditions.push(
				sql`(${content.markdown} ILIKE ${'%' + search + '%'} OR ${content.metadata}::text ILIKE ${'%' + search + '%'})`,
			)
		}

		const where = and(...conditions)
		const orderDir = sortOrder === 'asc' ? asc : desc
		const orderCol = content[sortBy]

		const [items, countResult] = await Promise.all([
			app.db.select().from(content).where(where).orderBy(orderDir(orderCol)).limit(limit).offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(content).where(where),
		])

		return {
			data: items,
			pagination: {
				page,
				limit,
				total: Number(countResult[0].count),
				totalPages: Math.ceil(Number(countResult[0].count) / limit),
			},
		}
	})

	// Get content by slug (viewer+, project-scoped)
	app.get<{ Params: { slug: string }; Querystring: { locale?: string } }>(
		'/by-slug/:slug',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			const conditions = [eq(content.projectId, request.project!.id), eq(content.slug, request.params.slug)]
			if (request.query.locale) conditions.push(eq(content.locale, request.query.locale))

			const [item] = await app.db.select().from(content).where(and(...conditions)).limit(1)
			if (!item) return reply.status(404).send({ error: 'Content not found' })
			return item
		},
	)

	// Get single content by ID (viewer+, project-scoped)
	app.get<{ Params: { id: string } }>('/:id', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const [item] = await app.db
			.select()
			.from(content)
			.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
			.limit(1)

		if (!item) return reply.status(404).send({ error: 'Content not found' })
		return item
	})

	// Create content (editor+, project-scoped)
	app.post('/', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const input = contentInputSchema.parse(request.body)
		const html = await marked(input.markdown)

		const [created] = await app.db
			.insert(content)
			.values({
				projectId: request.project!.id,
				slug: input.slug,
				collectionId: input.collectionId,
				metadata: input.metadata || {},
				markdown: input.markdown,
				html,
				locale: input.locale || 'en',
				status: input.status || 'draft',
				createdBy: request.user!.id,
			})
			.returning()

		app.events.emit({
			type: 'content:created',
			data: { id: created.id, slug: created.slug, status: created.status, projectId: request.project!.id },
			timestamp: new Date().toISOString(),
		})

		return reply.status(201).send(created)
	})

	// Update content (editor+, project-scoped)
	app.put<{ Params: { id: string } }>('/:id', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const input = contentInputSchema.partial().parse(request.body)

		const [current] = await app.db
			.select()
			.from(content)
			.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
			.limit(1)

		if (!current) return reply.status(404).send({ error: 'Content not found' })

		await app.db.insert(contentVersions).values({
			contentId: current.id,
			version: current.version,
			markdown: current.markdown,
			metadata: current.metadata,
			createdBy: request.user!.id,
		})

		const html = input.markdown ? await marked(input.markdown) : undefined
		const newVersion = current.version + 1

		const [updated] = await app.db
			.update(content)
			.set({
				...input,
				...(html && { html }),
				version: newVersion,
				updatedAt: new Date(),
				...(input.status === 'published' && !current.publishedAt ? { publishedAt: new Date() } : {}),
			})
			.where(eq(content.id, request.params.id))
			.returning()

		const eventType = updated.status === 'published' ? 'content:published' : 'content:updated'
		app.events.emit({
			type: eventType,
			data: { id: updated.id, slug: updated.slug, version: updated.version, projectId: request.project!.id },
			timestamp: new Date().toISOString(),
		})

		return updated
	})

	// Delete content (admin+, project-scoped)
	app.delete<{ Params: { id: string } }>('/:id', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const [deleted] = await app.db
			.delete(content)
			.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
			.returning()

		if (!deleted) return reply.status(404).send({ error: 'Content not found' })

		app.events.emit({
			type: 'content:deleted',
			data: { id: deleted.id, slug: deleted.slug, projectId: request.project!.id },
			timestamp: new Date().toISOString(),
		})

		return reply.status(204).send()
	})

	// Revert content (editor+, project-scoped)
	app.post<{ Params: { id: string; version: string } }>(
		'/:id/revert/:version',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			const [current] = await app.db
				.select()
				.from(content)
				.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
				.limit(1)

			if (!current) return reply.status(404).send({ error: 'Content not found' })

			const targetVersion = Number(request.params.version)
			const [version] = await app.db
				.select()
				.from(contentVersions)
				.where(and(eq(contentVersions.contentId, request.params.id), eq(contentVersions.version, targetVersion)))
				.limit(1)

			if (!version) return reply.status(404).send({ error: `Version ${targetVersion} not found` })

			await app.db.insert(contentVersions).values({
				contentId: current.id,
				version: current.version,
				markdown: current.markdown,
				metadata: current.metadata,
			})

			const html = await marked(version.markdown)
			const [reverted] = await app.db
				.update(content)
				.set({ markdown: version.markdown, metadata: version.metadata, html, version: current.version + 1, updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:updated',
				data: { id: reverted.id, slug: reverted.slug, revertedTo: targetVersion, projectId: request.project!.id },
				timestamp: new Date().toISOString(),
			})

			return reverted
		},
	)

	// Get content versions (viewer+, project-scoped)
	app.get<{ Params: { id: string } }>('/:id/versions', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db
			.select()
			.from(contentVersions)
			.where(eq(contentVersions.contentId, request.params.id))
			.orderBy(desc(contentVersions.version))
	})
}
