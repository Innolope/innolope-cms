import { content, contentVersions, contentAnalytics } from '@innolope/db'
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

		// Track search analytics (fire-and-forget)
		if (search) {
			app.db.insert(contentAnalytics).values({
				projectId: pid,
				event: items.length > 0 ? 'search_hit' : 'search_miss',
				query: search,
				source: 'api',
			}).catch(() => {})
		}

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

			// Track read analytics (fire-and-forget)
			app.db.insert(contentAnalytics).values({
				projectId: request.project!.id,
				contentId: item.id,
				event: 'api_read',
				source: 'api',
			}).catch(() => {})

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

		// Track read analytics (fire-and-forget)
		app.db.insert(contentAnalytics).values({
			projectId: request.project!.id,
			contentId: item.id,
			event: 'api_read',
			source: 'api',
		}).catch(() => {})

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

	// Bulk create content (editor+, project-scoped)
	app.post('/bulk', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const { items } = request.body as { items: Array<{ slug: string; collectionId: string; markdown: string; metadata?: Record<string, unknown>; locale?: string; status?: string }> }

		if (!Array.isArray(items) || items.length === 0) return reply.status(400).send({ error: 'items array is required' })
		if (items.length > 50) return reply.status(400).send({ error: 'Maximum 50 items per bulk create' })

		const created = await app.db.transaction(async (tx) => {
			const results = []
			for (const item of items) {
				const html = await marked(item.markdown)
				const [result] = await tx.insert(content).values({
					projectId: request.project!.id,
					slug: item.slug,
					collectionId: item.collectionId,
					metadata: item.metadata || {},
					markdown: item.markdown,
					html,
					locale: item.locale || 'en',
					status: (item.status || 'draft') as 'draft' | 'published',
					createdBy: request.user!.id,
				}).returning()
				results.push(result)
			}
			return results
		})

		for (const result of created) {
			app.events.emit({
				type: 'content:created',
				data: { id: result.id, slug: result.slug, status: result.status, projectId: request.project!.id },
				timestamp: new Date().toISOString(),
			})
		}

		return reply.status(201).send({ data: created, count: created.length })
	})

	// Bulk update content (editor+, project-scoped)
	app.put('/bulk', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const { items } = request.body as { items: Array<{ id: string; slug?: string; markdown?: string; metadata?: Record<string, unknown>; status?: string }> }

		if (!Array.isArray(items) || items.length === 0) return reply.status(400).send({ error: 'items array is required' })
		if (items.length > 50) return reply.status(400).send({ error: 'Maximum 50 items per bulk update' })

		const updated = await app.db.transaction(async (tx) => {
			const results = []
			for (const item of items) {
				const html = item.markdown ? await marked(item.markdown) : undefined
				const [result] = await tx
					.update(content)
					.set({
						...(item.slug && { slug: item.slug }),
						...(item.markdown && { markdown: item.markdown }),
						...(html && { html }),
						...(item.metadata && { metadata: item.metadata }),
						...(item.status && { status: item.status as 'draft' | 'pending_review' | 'published' | 'archived' }),
						updatedAt: new Date(),
					})
					.where(and(eq(content.id, item.id), eq(content.projectId, request.project!.id)))
					.returning()

				if (result) results.push(result)
			}
			return results
		})

		for (const result of updated) {
			app.events.emit({
				type: 'content:updated',
				data: { id: result.id, slug: result.slug, projectId: request.project!.id },
				timestamp: new Date().toISOString(),
			})
		}

		return { data: updated, count: updated.length }
	})

	// Query content by metadata fields (viewer+, project-scoped)
	app.post('/query-by-fields', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const { collectionId, filters, page = 1, limit = 25 } = request.body as {
			collectionId: string
			filters: Record<string, unknown>
			page?: number
			limit?: number
		}

		const conditions = [eq(content.projectId, request.project!.id)]
		if (collectionId) conditions.push(eq(content.collectionId, collectionId))

		// Add JSONB field filters (field names validated to prevent injection)
		for (const [field, value] of Object.entries(filters || {})) {
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) continue
			conditions.push(sql`${content.metadata}->>${sql.raw(`'${field}'`)} = ${String(value)}`)
		}

		const where = and(...conditions)
		const offset = (Number(page) - 1) * Number(limit)

		const [items, countResult] = await Promise.all([
			app.db.select().from(content).where(where).orderBy(desc(content.updatedAt)).limit(Number(limit)).offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(content).where(where),
		])

		return {
			data: items,
			pagination: { page: Number(page), limit: Number(limit), total: Number(countResult[0].count) },
		}
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
				.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
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
	app.get<{ Params: { id: string } }>('/:id/versions', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		// Verify content belongs to this project before returning versions
		const [item] = await app.db.select({ id: content.id }).from(content)
			.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
			.limit(1)
		if (!item) return reply.status(404).send({ error: 'Content not found' })

		return app.db
			.select()
			.from(contentVersions)
			.where(eq(contentVersions.contentId, request.params.id))
			.orderBy(desc(contentVersions.version))
	})

	// Review queue (viewer+, project-scoped, license-gated)
	app.get('/review-queue', { preHandler: [app.requireProject('viewer'), app.requireLicense('review-workflows')] }, async (request) => {
		const { page = 1, limit = 25 } = request.query as { page?: number; limit?: number }
		const offset = (Number(page) - 1) * Number(limit)
		const pid = request.project!.id

		const where = and(eq(content.projectId, pid), eq(content.status, 'pending_review'))

		const [items, countResult] = await Promise.all([
			app.db.select().from(content).where(where).orderBy(desc(content.updatedAt)).limit(Number(limit)).offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(content).where(where),
		])

		return {
			data: items,
			pagination: {
				page: Number(page),
				limit: Number(limit),
				total: Number(countResult[0].count),
				totalPages: Math.ceil(Number(countResult[0].count) / Number(limit)),
			},
		}
	})

	// Submit for review (editor+, project-scoped, license-gated)
	app.post<{ Params: { id: string } }>(
		'/:id/submit-for-review',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('review-workflows')] },
		async (request, reply) => {
			const [item] = await app.db
				.select()
				.from(content)
				.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status !== 'draft') return reply.status(400).send({ error: 'Only drafts can be submitted for review' })

			const [updated] = await app.db
				.update(content)
				.set({ status: 'pending_review', updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:submitted',
				data: { id: updated.id, slug: updated.slug, projectId: request.project!.id },
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)

	// Approve content (admin+, project-scoped, license-gated)
	app.post<{ Params: { id: string } }>(
		'/:id/approve',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('review-workflows')] },
		async (request, reply) => {
			const [item] = await app.db
				.select()
				.from(content)
				.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status !== 'pending_review') return reply.status(400).send({ error: 'Only pending review items can be approved' })

			const [updated] = await app.db
				.update(content)
				.set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:approved',
				data: { id: updated.id, slug: updated.slug, projectId: request.project!.id },
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)

	// Reject content (admin+, project-scoped, license-gated)
	app.post<{ Params: { id: string } }>(
		'/:id/reject',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('review-workflows')] },
		async (request, reply) => {
			const { reason } = (request.body as { reason?: string }) || {}

			const [item] = await app.db
				.select()
				.from(content)
				.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status !== 'pending_review') return reply.status(400).send({ error: 'Only pending review items can be rejected' })

			const [updated] = await app.db
				.update(content)
				.set({ status: 'draft', updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:rejected',
				data: { id: updated.id, slug: updated.slug, reason, projectId: request.project!.id },
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)
}
