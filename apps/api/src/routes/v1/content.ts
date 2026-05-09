import { content, contentVersions, contentAnalytics, collections, projects } from '@innolope/db'
import { contentInputSchema, contentListSchema } from '@innolope/config'
import type { FastifyInstance } from 'fastify'
import { eq, desc, asc, and, sql } from 'drizzle-orm'
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html)
}
import { createExternalDbAdapter } from '../../adapters/external-db.js'

type ExternalDbConfig = {
	type: string
	connectionString: string
	database?: string
}

function getExternalDbConfig(project: typeof projects.$inferSelect | undefined): ExternalDbConfig | null {
	const extDb = (project?.settings as unknown as Record<string, unknown>)?.externalDb as Record<string, unknown> | undefined
	if (!extDb?.type || !extDb?.connectionString) return null
	return {
		type: extDb.type as string,
		connectionString: extDb.connectionString as string,
		database: extDb.database as string | undefined,
	}
}

function buildExternalData(
	col: typeof collections.$inferSelect,
	input: { metadata?: Record<string, unknown>; markdown?: string; slug?: string },
): Record<string, unknown> {
	const fieldNames = new Set((col.fields || []).map((field) => field.name))
	const data: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(input.metadata || {})) {
		if (fieldNames.size === 0 || fieldNames.has(key)) data[key] = value
	}

	if (input.slug && fieldNames.has('slug')) data.slug = input.slug

	const bodyField = ['content', 'body', 'markdown', 'text', 'html'].find((field) => fieldNames.has(field))
	if (bodyField && input.markdown !== undefined) data[bodyField] = input.markdown

	return data
}

async function insertIntoExternalDb(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect,
	data: Record<string, unknown>,
) {
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb || !col.externalTable) throw new Error('External database is not configured')

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		return await adapter.insert(col.externalTable, data)
	} finally {
		await adapter.disconnect()
	}
}

async function updateExternalDb(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect,
	externalId: string,
	data: Record<string, unknown>,
) {
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb || !col.externalTable) throw new Error('External database is not configured')

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		return await adapter.update(col.externalTable, externalId, data)
	} finally {
		await adapter.disconnect()
	}
}

async function deleteFromExternalDb(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect,
	externalId: string,
) {
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb || !col.externalTable) return

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		await adapter.delete(col.externalTable, externalId)
	} finally {
		await adapter.disconnect()
	}
}

function httpError(message: string, statusCode: number) {
	return Object.assign(new Error(message), { statusCode })
}

export async function contentRoutes(app: FastifyInstance) {
	// List content (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const params = contentListSchema.parse(request.query)
		const {
			page, limit, sortBy, sortOrder, status, collectionId, locale, search,
			updatedFrom, updatedTo, createdFrom, createdTo, publishedFrom, publishedTo, metadata,
		} = params
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

		// Date range filters — strings are passed through to Postgres which parses them
		if (updatedFrom) conditions.push(sql`${content.updatedAt} >= ${updatedFrom}`)
		if (updatedTo) conditions.push(sql`${content.updatedAt} <= ${updatedTo}`)
		if (createdFrom) conditions.push(sql`${content.createdAt} >= ${createdFrom}`)
		if (createdTo) conditions.push(sql`${content.createdAt} <= ${createdTo}`)
		if (publishedFrom) conditions.push(sql`${content.publishedAt} >= ${publishedFrom}`)
		if (publishedTo) conditions.push(sql`${content.publishedAt} <= ${publishedTo}`)

		// Metadata equality filters: keys validated against identifier regex to keep injection out of sql.raw
		if (metadata) {
			try {
				const parsed = JSON.parse(metadata) as Record<string, unknown>
				if (parsed && typeof parsed === 'object') {
					for (const [field, value] of Object.entries(parsed)) {
						if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) continue
						if (value === null || value === undefined || value === '') continue
						conditions.push(sql`${content.metadata}->>${sql.raw(`'${field}'`)} = ${String(value)}`)
					}
				}
			} catch {
				// Ignore malformed metadata param rather than 500ing
			}
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
		const html = sanitizeHtml(await marked(input.markdown))
		const [col] = await app.db.select().from(collections)
			.where(and(eq(collections.id, input.collectionId), eq(collections.projectId, request.project!.id)))
			.limit(1)

		if (!col) return reply.status(404).send({ error: 'Collection not found' })
		if (col.source === 'external' && col.accessMode === 'read-only') {
			return reply.status(403).send({ error: 'This collection is read-only' })
		}

		const [duplicate] = await app.db.select({ id: content.id }).from(content)
			.where(and(eq(content.projectId, request.project!.id), eq(content.slug, input.slug), eq(content.locale, input.locale || 'en')))
			.limit(1)
		if (duplicate) return reply.status(409).send({ error: 'Content with this slug and locale already exists' })

		let externalId: string | undefined
		if (col.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
			const externalData = buildExternalData(col, {
				slug: input.slug,
				metadata: input.metadata,
				markdown: input.markdown,
			})
			const inserted = await insertIntoExternalDb(app, request.project!.id, col, externalData)
			externalId = inserted?._id
		}

		let created: typeof content.$inferSelect
		try {
			;[created] = await app.db
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
					...(externalId && { externalId }),
					...(input.createdAt && { createdAt: new Date(input.createdAt) }),
					...(input.updatedAt && { updatedAt: new Date(input.updatedAt) }),
					...(input.publishedAt && { publishedAt: new Date(input.publishedAt) }),
				})
				.returning()
		} catch (err) {
			if (externalId) {
				await deleteFromExternalDb(app, request.project!.id, col, externalId).catch((cleanupErr) => {
					app.log.error(cleanupErr, 'Failed to clean up external row after CMS create failed')
				})
			}
			throw err
		}

		app.events.emit({
			type: 'content:created',
			data: { id: created.id, slug: created.slug, status: created.status, projectId: request.project!.id },
			timestamp: new Date().toISOString(),
		})

		return reply.status(201).send(created)
	})

	// Bulk create content (editor+, project-scoped)
	app.post('/bulk', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const { items } = request.body as { items: Array<{ slug: string; collectionId: string; markdown: string; metadata?: Record<string, unknown>; locale?: string; status?: string; createdAt?: string; updatedAt?: string; publishedAt?: string }> }

		if (!Array.isArray(items) || items.length === 0) return reply.status(400).send({ error: 'items array is required' })
		if (items.length > 50) return reply.status(400).send({ error: 'Maximum 50 items per bulk create' })

		const insertedExternalRows: Array<{ col: typeof collections.$inferSelect; externalId: string }> = []
		let created: Array<typeof content.$inferSelect>
		try {
			created = await app.db.transaction(async (tx) => {
				const results = []
				for (const item of items) {
					const html = sanitizeHtml(await marked(item.markdown))
					const [col] = await tx.select().from(collections)
						.where(and(eq(collections.id, item.collectionId), eq(collections.projectId, request.project!.id)))
						.limit(1)

					if (!col) throw httpError(`Collection not found: ${item.collectionId}`, 400)
					if (col.source === 'external' && col.accessMode === 'read-only') {
						throw httpError(`Collection is read-only: ${col.name}`, 403)
					}

					const [duplicate] = await tx.select({ id: content.id }).from(content)
						.where(and(eq(content.projectId, request.project!.id), eq(content.slug, item.slug), eq(content.locale, item.locale || 'en')))
						.limit(1)
					if (duplicate) throw httpError(`Content with slug already exists: ${item.slug}`, 409)

					let externalId: string | undefined
					if (col.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
						const externalData = buildExternalData(col, {
							slug: item.slug,
							metadata: item.metadata,
							markdown: item.markdown,
						})
						const inserted = await insertIntoExternalDb(app, request.project!.id, col, externalData)
						externalId = inserted?._id
						if (externalId) insertedExternalRows.push({ col, externalId })
					}

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
						...(externalId && { externalId }),
						...(item.createdAt && { createdAt: new Date(item.createdAt) }),
						...(item.updatedAt && { updatedAt: new Date(item.updatedAt) }),
						...(item.publishedAt && { publishedAt: new Date(item.publishedAt) }),
					}).returning()
					results.push(result)
				}
				return results
			})
		} catch (err) {
			await Promise.all(insertedExternalRows.map(({ col, externalId }) =>
				deleteFromExternalDb(app, request.project!.id, col, externalId).catch((cleanupErr) => {
					app.log.error(cleanupErr, 'Failed to clean up external row after bulk CMS create failed')
				}),
			))
			throw err
		}

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
				const [current] = await tx
					.select()
					.from(content)
					.where(and(eq(content.id, item.id), eq(content.projectId, request.project!.id)))
					.limit(1)
				if (!current) throw httpError(`Content not found: ${item.id}`, 404)

				const [col] = await tx.select().from(collections)
					.where(and(eq(collections.id, current.collectionId), eq(collections.projectId, request.project!.id)))
					.limit(1)

				let externalId = current.externalId
				if (col?.source === 'external' && col.accessMode === 'read-only') {
					throw httpError(`Collection is read-only: ${col.name}`, 403)
				}
				if (col?.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
					const nextMetadata = { ...current.metadata, ...item.metadata }
					const externalData = buildExternalData(col, {
						slug: item.slug ?? current.slug,
						metadata: nextMetadata,
						markdown: item.markdown ?? current.markdown,
					})

					if (externalId) {
						await updateExternalDb(app, request.project!.id, col, externalId, externalData)
					} else {
						const inserted = await insertIntoExternalDb(app, request.project!.id, col, externalData)
						externalId = inserted?._id ?? null
					}
				}

				const html = item.markdown ? sanitizeHtml(await marked(item.markdown)) : undefined
				const [result] = await tx
					.update(content)
					.set({
						...(item.slug && { slug: item.slug }),
						...(item.markdown && { markdown: item.markdown }),
						...(html && { html }),
						...(item.metadata && { metadata: item.metadata }),
						...(item.status && { status: item.status as 'draft' | 'pending_review' | 'published' | 'archived' }),
						updatedAt: new Date(),
						...(externalId && { externalId }),
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
		// Strip create-only timestamp fields — updates must not backdate createdAt or rewrite history.
		const { createdAt: _ca, updatedAt: _ua, publishedAt: _pa, ...input } = contentInputSchema.partial().parse(request.body)

		const [current] = await app.db
			.select()
			.from(content)
			.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
			.limit(1)

		if (!current) return reply.status(404).send({ error: 'Content not found' })

		const [col] = await app.db.select().from(collections)
			.where(and(eq(collections.id, current.collectionId), eq(collections.projectId, request.project!.id)))
			.limit(1)

		let externalId = current.externalId
		if (col?.source === 'external' && col.accessMode === 'read-only') {
			return reply.status(403).send({ error: 'This collection is read-only' })
		}

		if (col?.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
			const nextMetadata = { ...current.metadata, ...input.metadata }
			const externalData = buildExternalData(col, {
				slug: input.slug ?? current.slug,
				metadata: nextMetadata,
				markdown: input.markdown ?? current.markdown,
			})

			try {
				if (externalId) {
					await updateExternalDb(app, request.project!.id, col, externalId, externalData)
				} else {
					const inserted = await insertIntoExternalDb(app, request.project!.id, col, externalData)
					externalId = inserted?._id ?? null
				}
			} catch (err) {
				app.log.warn(err, 'Failed to sync to external DB')
				return reply.status(502).send({ error: 'Failed to sync to external database' })
			}
		}

		await app.db.insert(contentVersions).values({
			contentId: current.id,
			version: current.version,
			markdown: current.markdown,
			metadata: current.metadata,
			createdBy: request.user!.id,
		})

		const html = input.markdown ? sanitizeHtml(await marked(input.markdown)) : undefined
		const newVersion = current.version + 1

		const [updated] = await app.db
			.update(content)
			.set({
				...input,
				...(html && { html }),
				version: newVersion,
				updatedAt: new Date(),
				...(input.status === 'published' && !current.publishedAt ? { publishedAt: new Date() } : {}),
				...(externalId && { externalId }),
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

			const html = sanitizeHtml(await marked(version.markdown))
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
