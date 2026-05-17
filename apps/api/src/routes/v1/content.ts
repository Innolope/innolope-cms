import { contentInputSchema, contentListSchema } from '@innolope/config'
import { collections, content, contentAnalytics, contentVersions, projects } from '@innolope/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { getUser } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'

function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html)
}

import { createExternalDbAdapter } from '../../adapters/external-db.js'
import { externalDocToContentItem } from '../../services/markdown-cache.js'

type ExternalDbConfig = {
	type: string
	connectionString: string
	database?: string
}

function getExternalDbConfig(
	project: typeof projects.$inferSelect | undefined,
): ExternalDbConfig | null {
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

function buildExternalData(
	col: typeof collections.$inferSelect,
	input: {
		metadata?: Record<string, unknown>
		markdown?: string
		slug?: string
		status?: string
		createdAt?: string | Date
		updatedAt?: string | Date
		publishedAt?: string | Date | null
	},
): Record<string, unknown> {
	const fields = col.fields || []
	const fieldNames = new Set(fields.map((field) => field.name))
	const data: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(input.metadata || {})) {
		if (fieldNames.size === 0 || fieldNames.has(key)) {
			data[key] = coerceExternalFieldValue(fields.find((field) => field.name === key)?.type, value)
		}
	}

	if (input.slug && fieldNames.has('slug')) data.slug = input.slug
	if (input.status && fieldNames.has('status')) {
		data.status = coerceExternalFieldValue(
			fields.find((field) => field.name === 'status')?.type,
			input.status,
		)
	}

	const bodyField = ['content', 'body', 'markdown', 'text', 'html'].find((field) =>
		fieldNames.has(field),
	)
	if (bodyField && input.markdown !== undefined) data[bodyField] = input.markdown

	const timestampValues: Record<string, string | Date | null | undefined> = {
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		publishedAt: input.publishedAt,
	}
	for (const [fieldName, value] of Object.entries(timestampValues)) {
		if (value !== undefined && fieldNames.has(fieldName)) {
			data[fieldName] = coerceExternalFieldValue(
				fields.find((field) => field.name === fieldName)?.type,
				value,
			)
		}
	}

	return data
}

function coerceExternalFieldValue(fieldType: string | undefined, value: unknown): unknown {
	if (value === null || value === undefined) return value
	if (fieldType !== 'date') return value
	if (value instanceof Date) return value
	if (typeof value === 'string' || typeof value === 'number') {
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? value : date
	}
	return value
}

/** MongoDB stores references as ObjectId — wrap 24-hex relation values so the field type stays consistent. */
async function coerceExternalRelations(
	dbType: string,
	col: typeof collections.$inferSelect,
	data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (dbType !== 'mongodb') return data
	const relationFields = (col.fields || []).filter((f) => f.type === 'relation').map((f) => f.name)
	if (relationFields.length === 0) return data
	const { ObjectId } = await import('mongodb')
	const isObjectIdString = (v: unknown): v is string =>
		typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v)
	const out = { ...data }
	for (const name of relationFields) {
		const value = out[name]
		if (isObjectIdString(value)) {
			out[name] = new ObjectId(value)
		} else if (Array.isArray(value)) {
			out[name] = value.map((item) => (isObjectIdString(item) ? new ObjectId(item) : item))
		}
	}
	return out
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
		return await adapter.insert(
			col.externalTable,
			await coerceExternalRelations(extDb.type, col, data),
		)
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
		return await adapter.update(
			col.externalTable,
			externalId,
			await coerceExternalRelations(extDb.type, col, data),
		)
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

/** Load an external collection + its project's external DB config, or null if not applicable. */
async function loadExternalCollection(
	app: FastifyInstance,
	projectId: string,
	collectionId: string,
) {
	const [col] = await app.db
		.select()
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	if (!col || col.source !== 'external' || !col.externalTable) return null

	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb) return null

	return { col, extDb }
}

/** Push a status change to the external DB row, if the collection is an external read-write source. */
async function syncExternalStatus(
	app: FastifyInstance,
	projectId: string,
	collectionId: string,
	externalId: string | null,
	status: string,
	publishedAt: Date | null,
) {
	const [col] = await app.db
		.select()
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	if (!col || col.source !== 'external' || col.accessMode !== 'read-write' || !col.externalTable)
		return
	if (!externalId) return
	const data = buildExternalData(col, { status, publishedAt })
	await updateExternalDb(app, projectId, col, externalId, data)
}

/** Fetch a page of records live from the external DB (used when the local cache is empty). */
async function fetchLiveExternalContent(
	app: FastifyInstance,
	projectId: string,
	collectionId: string,
	opts: { limit: number; offset: number },
): Promise<{ items: Record<string, unknown>[]; total: number } | null> {
	const loaded = await loadExternalCollection(app, projectId, collectionId)
	if (!loaded) return null
	const { col, extDb } = loaded
	if (!col.externalTable) return null

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		const total = await adapter.count(col.externalTable)
		const docs = await adapter.findAll(col.externalTable, opts)
		const items = docs.map((doc) =>
			externalDocToContentItem(doc, {
				id: col.id,
				projectId: col.projectId,
				fields: col.fields || [],
			}),
		)
		return { items, total }
	} finally {
		await adapter.disconnect()
	}
}

/** Fetch a single record live from the external DB (used when it is not in the local cache). */
async function fetchLiveExternalRecord(
	app: FastifyInstance,
	projectId: string,
	collectionId: string,
	externalId: string,
): Promise<Record<string, unknown> | null> {
	const loaded = await loadExternalCollection(app, projectId, collectionId)
	if (!loaded) return null
	const { col, extDb } = loaded
	if (!col.externalTable) return null

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		const doc = await adapter.findById(col.externalTable, externalId)
		if (!doc) return null
		return externalDocToContentItem(doc, {
			id: col.id,
			projectId: col.projectId,
			fields: col.fields || [],
		})
	} finally {
		await adapter.disconnect()
	}
}

export async function contentRoutes(app: FastifyInstance) {
	// List content (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const params = contentListSchema.parse(request.query)
		const {
			page,
			limit,
			sortBy,
			sortOrder,
			status,
			collectionId,
			locale,
			search,
			updatedFrom,
			updatedTo,
			createdFrom,
			createdTo,
			publishedFrom,
			publishedTo,
			metadata,
		} = params
		const offset = (page - 1) * limit
		const pid = getProject(request).id

		const conditions = [eq(content.projectId, pid)]
		if (status) conditions.push(eq(content.status, status))
		if (collectionId) conditions.push(eq(content.collectionId, collectionId))
		if (locale) conditions.push(eq(content.locale, locale))
		if (search) {
			conditions.push(
				sql`(${content.markdown} ILIKE ${`%${search}%`} OR ${content.metadata}::text ILIKE ${`%${search}%`})`,
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
			app.db
				.select()
				.from(content)
				.where(where)
				.orderBy(orderDir(orderCol))
				.limit(limit)
				.offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(content).where(where),
		])

		// Live fallback: local cache is empty for this external collection — read directly
		// from the external DB so records stay visible before a Sync runs.
		if (collectionId && Number(countResult[0].count) === 0) {
			try {
				const live = await fetchLiveExternalContent(app, pid, collectionId, { limit, offset })
				if (live) {
					return {
						data: live.items,
						pagination: {
							page,
							limit,
							total: live.total,
							totalPages: Math.ceil(live.total / limit),
						},
						live: true,
					}
				}
			} catch (err) {
				app.log.warn(err, 'Live external content fallback failed')
			}
		}

		// Track search analytics (fire-and-forget)
		if (search) {
			app.db
				.insert(contentAnalytics)
				.values({
					projectId: pid,
					event: items.length > 0 ? 'search_hit' : 'search_miss',
					query: search,
					source: 'api',
				})
				.catch(() => {})
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
			const conditions = [
				eq(content.projectId, getProject(request).id),
				eq(content.slug, request.params.slug),
			]
			if (request.query.locale) conditions.push(eq(content.locale, request.query.locale))

			const [item] = await app.db
				.select()
				.from(content)
				.where(and(...conditions))
				.limit(1)
			if (!item) return reply.status(404).send({ error: 'Content not found' })

			// Track read analytics (fire-and-forget)
			app.db
				.insert(contentAnalytics)
				.values({
					projectId: getProject(request).id,
					contentId: item.id,
					event: 'api_read',
					source: 'api',
				})
				.catch(() => {})

			return item
		},
	)

	// Get single content by ID (viewer+, project-scoped)
	app.get<{ Params: { id: string }; Querystring: { collectionId?: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			// The id may be an external id (non-UUID) when it refers to a live external row,
			// which makes the uuid-typed local lookup throw — treat that as "not found locally".
			let item: typeof content.$inferSelect | undefined
			try {
				;[item] = await app.db
					.select()
					.from(content)
					.where(
						and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
					)
					.limit(1)
			} catch {
				item = undefined
			}

			// External rows are linked by their external id, not the local uuid — match on that
			// before falling back to a live read, so a synced collection is recognised as cached.
			if (!item) {
				;[item] = await app.db
					.select()
					.from(content)
					.where(
						and(
							eq(content.externalId, request.params.id),
							eq(content.projectId, getProject(request).id),
						),
					)
					.limit(1)
			}

			// Live fallback: not in the local cache — try reading the row directly from the external DB.
			if (!item && request.query.collectionId) {
				try {
					const live = await fetchLiveExternalRecord(
						app,
						getProject(request).id,
						request.query.collectionId,
						request.params.id,
					)
					if (live) return live
				} catch (err) {
					app.log.warn(err, 'Live external record fallback failed')
				}
			}

			if (!item) return reply.status(404).send({ error: 'Content not found' })

			// Track read analytics (fire-and-forget)
			app.db
				.insert(contentAnalytics)
				.values({
					projectId: getProject(request).id,
					contentId: item.id,
					event: 'api_read',
					source: 'api',
				})
				.catch(() => {})

			return item
		},
	)

	// Create content (editor+, project-scoped)
	app.post('/', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const input = contentInputSchema.parse(request.body)
		const html = sanitizeHtml(await marked(input.markdown))
		const [col] = await app.db
			.select()
			.from(collections)
			.where(
				and(
					eq(collections.id, input.collectionId),
					eq(collections.projectId, getProject(request).id),
				),
			)
			.limit(1)

		if (!col) return reply.status(404).send({ error: 'Collection not found' })
		if (col.source === 'external' && col.accessMode === 'read-only') {
			return reply.status(403).send({ error: 'This collection is read-only' })
		}

		const [duplicate] = await app.db
			.select({ id: content.id })
			.from(content)
			.where(
				and(
					eq(content.projectId, getProject(request).id),
					eq(content.slug, input.slug),
					eq(content.locale, input.locale || 'en'),
				),
			)
			.limit(1)
		if (duplicate)
			return reply.status(409).send({ error: 'Content with this slug and locale already exists' })

		let externalId: string | undefined
		if (col.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
			const now = new Date()
			const externalData = buildExternalData(col, {
				slug: input.slug,
				status: input.status || 'draft',
				metadata: input.metadata,
				markdown: input.markdown,
				createdAt: input.createdAt || now,
				updatedAt: input.updatedAt || now,
				publishedAt: input.publishedAt || (input.status === 'published' ? now : null),
			})
			const inserted = await insertIntoExternalDb(app, getProject(request).id, col, externalData)
			externalId = inserted?._id
		}

		let created: typeof content.$inferSelect
		try {
			;[created] = await app.db
				.insert(content)
				.values({
					projectId: getProject(request).id,
					slug: input.slug,
					collectionId: input.collectionId,
					metadata: input.metadata || {},
					markdown: input.markdown,
					html,
					locale: input.locale || 'en',
					status: input.status || 'draft',
					createdBy: getUser(request).id,
					...(externalId && { externalId }),
					...(input.createdAt && { createdAt: new Date(input.createdAt) }),
					...(input.updatedAt && { updatedAt: new Date(input.updatedAt) }),
					...(input.publishedAt && { publishedAt: new Date(input.publishedAt) }),
				})
				.returning()
		} catch (err) {
			if (externalId) {
				await deleteFromExternalDb(app, getProject(request).id, col, externalId).catch(
					(cleanupErr) => {
						app.log.error(cleanupErr, 'Failed to clean up external row after CMS create failed')
					},
				)
			}
			throw err
		}

		app.events.emit({
			type: 'content:created',
			data: {
				id: created.id,
				slug: created.slug,
				status: created.status,
				projectId: getProject(request).id,
			},
			timestamp: new Date().toISOString(),
		})

		return reply.status(201).send(created)
	})

	// Bulk create content (editor+, project-scoped)
	app.post('/bulk', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const { items } = request.body as {
			items: Array<{
				slug: string
				collectionId: string
				markdown: string
				metadata?: Record<string, unknown>
				locale?: string
				status?: string
				createdAt?: string
				updatedAt?: string
				publishedAt?: string
			}>
		}

		if (!Array.isArray(items) || items.length === 0)
			return reply.status(400).send({ error: 'items array is required' })
		if (items.length > 50)
			return reply.status(400).send({ error: 'Maximum 50 items per bulk create' })

		const insertedExternalRows: Array<{
			col: typeof collections.$inferSelect
			externalId: string
		}> = []
		let created: Array<typeof content.$inferSelect>
		try {
			created = await app.db.transaction(async (tx) => {
				const results = []
				for (const item of items) {
					const html = sanitizeHtml(await marked(item.markdown))
					const [col] = await tx
						.select()
						.from(collections)
						.where(
							and(
								eq(collections.id, item.collectionId),
								eq(collections.projectId, getProject(request).id),
							),
						)
						.limit(1)

					if (!col) throw httpError(`Collection not found: ${item.collectionId}`, 400)
					if (col.source === 'external' && col.accessMode === 'read-only') {
						throw httpError(`Collection is read-only: ${col.name}`, 403)
					}

					const [duplicate] = await tx
						.select({ id: content.id })
						.from(content)
						.where(
							and(
								eq(content.projectId, getProject(request).id),
								eq(content.slug, item.slug),
								eq(content.locale, item.locale || 'en'),
							),
						)
						.limit(1)
					if (duplicate) throw httpError(`Content with slug already exists: ${item.slug}`, 409)

					let externalId: string | undefined
					if (col.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
						const now = new Date()
						const externalData = buildExternalData(col, {
							slug: item.slug,
							status: item.status || 'draft',
							metadata: item.metadata,
							markdown: item.markdown,
							createdAt: item.createdAt || now,
							updatedAt: item.updatedAt || now,
							publishedAt: item.publishedAt || (item.status === 'published' ? now : null),
						})
						const inserted = await insertIntoExternalDb(
							app,
							getProject(request).id,
							col,
							externalData,
						)
						externalId = inserted?._id
						if (externalId) insertedExternalRows.push({ col, externalId })
					}

					const [result] = await tx
						.insert(content)
						.values({
							projectId: getProject(request).id,
							slug: item.slug,
							collectionId: item.collectionId,
							metadata: item.metadata || {},
							markdown: item.markdown,
							html,
							locale: item.locale || 'en',
							status: (item.status || 'draft') as 'draft' | 'published',
							createdBy: getUser(request).id,
							...(externalId && { externalId }),
							...(item.createdAt && { createdAt: new Date(item.createdAt) }),
							...(item.updatedAt && { updatedAt: new Date(item.updatedAt) }),
							...(item.publishedAt && { publishedAt: new Date(item.publishedAt) }),
						})
						.returning()
					results.push(result)
				}
				return results
			})
		} catch (err) {
			await Promise.all(
				insertedExternalRows.map(({ col, externalId }) =>
					deleteFromExternalDb(app, getProject(request).id, col, externalId).catch((cleanupErr) => {
						app.log.error(
							cleanupErr,
							'Failed to clean up external row after bulk CMS create failed',
						)
					}),
				),
			)
			throw err
		}

		for (const result of created) {
			app.events.emit({
				type: 'content:created',
				data: {
					id: result.id,
					slug: result.slug,
					status: result.status,
					projectId: getProject(request).id,
				},
				timestamp: new Date().toISOString(),
			})
		}

		return reply.status(201).send({ data: created, count: created.length })
	})

	// Bulk update content (editor+, project-scoped)
	app.put('/bulk', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const { items } = request.body as {
			items: Array<{
				id: string
				slug?: string
				markdown?: string
				metadata?: Record<string, unknown>
				status?: string
			}>
		}

		if (!Array.isArray(items) || items.length === 0)
			return reply.status(400).send({ error: 'items array is required' })
		if (items.length > 50)
			return reply.status(400).send({ error: 'Maximum 50 items per bulk update' })

		const updated = await app.db.transaction(async (tx) => {
			const results = []
			for (const item of items) {
				const [current] = await tx
					.select()
					.from(content)
					.where(and(eq(content.id, item.id), eq(content.projectId, getProject(request).id)))
					.limit(1)
				if (!current) throw httpError(`Content not found: ${item.id}`, 404)

				const [col] = await tx
					.select()
					.from(collections)
					.where(
						and(
							eq(collections.id, current.collectionId),
							eq(collections.projectId, getProject(request).id),
						),
					)
					.limit(1)

				let externalId = current.externalId
				if (col?.source === 'external' && col.accessMode === 'read-only') {
					throw httpError(`Collection is read-only: ${col.name}`, 403)
				}
				if (col?.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
					const nextMetadata = { ...current.metadata, ...item.metadata }
					const now = new Date()
					const externalData = buildExternalData(col, {
						slug: item.slug ?? current.slug,
						status: item.status ?? current.status,
						metadata: nextMetadata,
						markdown: item.markdown ?? current.markdown,
						createdAt: current.createdAt,
						updatedAt: now,
						publishedAt:
							item.status === 'published' && !current.publishedAt ? now : current.publishedAt,
					})

					if (externalId) {
						await updateExternalDb(app, getProject(request).id, col, externalId, externalData)
					} else {
						const inserted = await insertIntoExternalDb(
							app,
							getProject(request).id,
							col,
							externalData,
						)
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
						...(item.status && {
							status: item.status as 'draft' | 'pending_review' | 'published' | 'archived',
						}),
						updatedAt: new Date(),
						...(externalId && { externalId }),
					})
					.where(and(eq(content.id, item.id), eq(content.projectId, getProject(request).id)))
					.returning()

				if (result) results.push(result)
			}
			return results
		})

		for (const result of updated) {
			app.events.emit({
				type: 'content:updated',
				data: { id: result.id, slug: result.slug, projectId: getProject(request).id },
				timestamp: new Date().toISOString(),
			})
		}

		return { data: updated, count: updated.length }
	})

	// Query content by metadata fields (viewer+, project-scoped)
	app.post('/query-by-fields', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const {
			collectionId,
			filters,
			page = 1,
			limit = 25,
		} = request.body as {
			collectionId: string
			filters: Record<string, unknown>
			page?: number
			limit?: number
		}

		const conditions = [eq(content.projectId, getProject(request).id)]
		if (collectionId) conditions.push(eq(content.collectionId, collectionId))

		// Add JSONB field filters (field names validated to prevent injection)
		for (const [field, value] of Object.entries(filters || {})) {
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) continue
			conditions.push(sql`${content.metadata}->>${sql.raw(`'${field}'`)} = ${String(value)}`)
		}

		const where = and(...conditions)
		const offset = (Number(page) - 1) * Number(limit)

		const [items, countResult] = await Promise.all([
			app.db
				.select()
				.from(content)
				.where(where)
				.orderBy(desc(content.updatedAt))
				.limit(Number(limit))
				.offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(content).where(where),
		])

		return {
			data: items,
			pagination: { page: Number(page), limit: Number(limit), total: Number(countResult[0].count) },
		}
	})

	// Update content (editor+, project-scoped)
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			// Strip create-only timestamp fields — updates must not backdate createdAt or rewrite history.
			const {
				createdAt: _ca,
				updatedAt: _ua,
				publishedAt: _pa,
				...input
			} = contentInputSchema.partial().parse(request.body)

			const [current] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!current) return reply.status(404).send({ error: 'Content not found' })

			const [col] = await app.db
				.select()
				.from(collections)
				.where(
					and(
						eq(collections.id, current.collectionId),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)

			let externalId = current.externalId
			if (col?.source === 'external' && col.accessMode === 'read-only') {
				return reply.status(403).send({ error: 'This collection is read-only' })
			}

			if (col?.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
				const nextMetadata = { ...current.metadata, ...input.metadata }
				const now = new Date()
				const externalData = buildExternalData(col, {
					slug: input.slug ?? current.slug,
					status: input.status ?? current.status,
					metadata: nextMetadata,
					markdown: input.markdown ?? current.markdown,
					createdAt: current.createdAt,
					updatedAt: now,
					publishedAt:
						input.status === 'published' && !current.publishedAt ? now : current.publishedAt,
				})

				try {
					if (externalId) {
						await updateExternalDb(app, getProject(request).id, col, externalId, externalData)
					} else {
						const inserted = await insertIntoExternalDb(
							app,
							getProject(request).id,
							col,
							externalData,
						)
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
				createdBy: getUser(request).id,
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
					...(input.status === 'published' && !current.publishedAt
						? { publishedAt: new Date() }
						: {}),
					...(externalId && { externalId }),
				})
				.where(eq(content.id, request.params.id))
				.returning()

			const eventType = updated.status === 'published' ? 'content:published' : 'content:updated'
			app.events.emit({
				type: eventType,
				data: {
					id: updated.id,
					slug: updated.slug,
					version: updated.version,
					projectId: getProject(request).id,
				},
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)

	// Delete content (admin+, project-scoped)
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const [deleted] = await app.db
				.delete(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.returning()

			if (!deleted) return reply.status(404).send({ error: 'Content not found' })

			app.events.emit({
				type: 'content:deleted',
				data: { id: deleted.id, slug: deleted.slug, projectId: getProject(request).id },
				timestamp: new Date().toISOString(),
			})

			return reply.status(204).send()
		},
	)

	// Revert content (editor+, project-scoped)
	app.post<{ Params: { id: string; version: string } }>(
		'/:id/revert/:version',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			const [current] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!current) return reply.status(404).send({ error: 'Content not found' })

			const targetVersion = Number(request.params.version)
			const [version] = await app.db
				.select()
				.from(contentVersions)
				.where(
					and(
						eq(contentVersions.contentId, request.params.id),
						eq(contentVersions.version, targetVersion),
					),
				)
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
				.set({
					markdown: version.markdown,
					metadata: version.metadata,
					html,
					version: current.version + 1,
					updatedAt: new Date(),
				})
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.returning()

			app.events.emit({
				type: 'content:updated',
				data: {
					id: reverted.id,
					slug: reverted.slug,
					revertedTo: targetVersion,
					projectId: getProject(request).id,
				},
				timestamp: new Date().toISOString(),
			})

			return reverted
		},
	)

	// Get content versions (viewer+, project-scoped)
	app.get<{ Params: { id: string } }>(
		'/:id/versions',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			// Verify content belongs to this project before returning versions
			const [item] = await app.db
				.select({ id: content.id })
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)
			if (!item) return reply.status(404).send({ error: 'Content not found' })

			return app.db
				.select()
				.from(contentVersions)
				.where(eq(contentVersions.contentId, request.params.id))
				.orderBy(desc(contentVersions.version))
		},
	)

	// Review queue (viewer+, project-scoped, license-gated)
	app.get(
		'/review-queue',
		{ preHandler: [app.requireProject('viewer'), app.requireLicense('review-workflows')] },
		async (request) => {
			const { page = 1, limit = 25 } = request.query as { page?: number; limit?: number }
			const offset = (Number(page) - 1) * Number(limit)
			const pid = getProject(request).id

			const where = and(eq(content.projectId, pid), eq(content.status, 'pending_review'))

			const [items, countResult] = await Promise.all([
				app.db
					.select()
					.from(content)
					.where(where)
					.orderBy(desc(content.updatedAt))
					.limit(Number(limit))
					.offset(offset),
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
		},
	)

	// Submit for review (editor+, project-scoped, license-gated)
	app.post<{ Params: { id: string } }>(
		'/:id/submit-for-review',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('review-workflows')] },
		async (request, reply) => {
			const [item] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status !== 'draft')
				return reply.status(400).send({ error: 'Only drafts can be submitted for review' })

			const [updated] = await app.db
				.update(content)
				.set({ status: 'pending_review', updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:submitted',
				data: { id: updated.id, slug: updated.slug, projectId: getProject(request).id },
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
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status !== 'pending_review')
				return reply.status(400).send({ error: 'Only pending review items can be approved' })

			try {
				await syncExternalStatus(
					app,
					getProject(request).id,
					item.collectionId,
					item.externalId,
					'published',
					new Date(),
				)
			} catch (err) {
				app.log.warn(err, 'Failed to sync approval to external DB')
				return reply.status(502).send({ error: 'Failed to sync to external database' })
			}

			const [updated] = await app.db
				.update(content)
				.set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:approved',
				data: { id: updated.id, slug: updated.slug, projectId: getProject(request).id },
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
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status !== 'pending_review')
				return reply.status(400).send({ error: 'Only pending review items can be rejected' })

			try {
				await syncExternalStatus(
					app,
					getProject(request).id,
					item.collectionId,
					item.externalId,
					'draft',
					null,
				)
			} catch (err) {
				app.log.warn(err, 'Failed to sync rejection to external DB')
				return reply.status(502).send({ error: 'Failed to sync to external database' })
			}

			const [updated] = await app.db
				.update(content)
				.set({ status: 'draft', updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:rejected',
				data: { id: updated.id, slug: updated.slug, reason, projectId: getProject(request).id },
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)

	// Create a record in a related external collection (e.g. uploading an image for a relation field)
	app.post(
		'/relation-records',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			const { relationTo, values } =
				(request.body as { relationTo?: string; values?: Record<string, unknown> }) || {}
			if (!relationTo || typeof relationTo !== 'string') {
				return reply.status(400).send({ error: 'relationTo is required' })
			}

			const [targetCol] = await app.db
				.select()
				.from(collections)
				.where(
					and(eq(collections.name, relationTo), eq(collections.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!targetCol)
				return reply.status(404).send({ error: `Related collection not found: ${relationTo}` })
			if (
				targetCol.source !== 'external' ||
				targetCol.accessMode !== 'read-write' ||
				!targetCol.externalTable
			) {
				return reply
					.status(400)
					.send({ error: 'Related collection is not an external read-write collection' })
			}

			const now = new Date()
			const data = buildExternalData(targetCol, {
				metadata: values || {},
				createdAt: now,
				updatedAt: now,
			})

			try {
				const inserted = await insertIntoExternalDb(app, getProject(request).id, targetCol, data)
				return reply.status(201).send({ _id: inserted._id })
			} catch (err) {
				app.log.warn(err, 'Failed to insert relation record')
				return reply.status(502).send({ error: 'Failed to write to external database' })
			}
		},
	)
}
