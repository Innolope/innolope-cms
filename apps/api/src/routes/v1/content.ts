import { contentInputSchema, contentListSchema } from '@innolope/config'
import {
	collections,
	content,
	contentAnalytics,
	contentVersions,
	importJobs,
	media,
	projects,
} from '@innolope/db'
import { type AnyColumn, and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { checkCollectionAccess, loadMemberCollectionAccess } from '../../lib/collection-access.js'
import { applyMediaStorage, getMediaStorageMap } from '../../lib/media-storage.js'
import { mediaRowToContentItem, resolveRelations } from '../../lib/resolve-relations.js'
import { getUser } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'

function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html)
}

import { createExternalDbAdapter, type ExternalDocument } from '../../adapters/external-db.js'
import { cacheMissingDocs, externalDocToContentItem } from '../../services/markdown-cache.js'

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
		slug?: string | null
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

	// System lifecycle timestamps — only a fallback. If the collection exposes
	// createdAt/updatedAt/publishedAt as editable fields and the user supplied a
	// value via metadata, that value (already in `data`) wins.
	const timestampValues: Record<string, string | Date | null | undefined> = {
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		publishedAt: input.publishedAt,
	}
	for (const [fieldName, value] of Object.entries(timestampValues)) {
		if (value !== undefined && fieldNames.has(fieldName) && !(fieldName in data)) {
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

/** True while a background import for this collection is queued or running. */
async function hasActiveImport(app: FastifyInstance, collectionId: string): Promise<boolean> {
	try {
		const [job] = await app.db
			.select({ id: importJobs.id })
			.from(importJobs)
			.where(
				and(
					eq(importJobs.collectionId, collectionId),
					inArray(importJobs.status, ['pending', 'running']),
				),
			)
			.limit(1)
		return Boolean(job)
	} catch (err) {
		// `import_jobs` backs an optional feature — if the table is missing or
		// unreadable it must not bring down the content list / record lookup.
		// Degrade to "no active import" so callers fall through to the cache.
		app.log.warn(err, 'hasActiveImport check failed — assuming no active import')
		return false
	}
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
): Promise<{
	item: Record<string, unknown>
	doc: ExternalDocument
	col: typeof collections.$inferSelect
} | null> {
	const loaded = await loadExternalCollection(app, projectId, collectionId)
	if (!loaded) return null
	const { col, extDb } = loaded
	if (!col.externalTable) return null

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		const doc = await adapter.findById(col.externalTable, externalId)
		if (!doc) return null
		const item = externalDocToContentItem(doc, {
			id: col.id,
			projectId: col.projectId,
			fields: col.fields || [],
		})
		return { item, doc, col }
	} finally {
		await adapter.disconnect()
	}
}

/** Apply imported media-library path resolution to items of an external collection. */
async function applyExternalMediaStorage(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect | undefined,
	items: Array<{ metadata?: Record<string, unknown> }>,
) {
	if (!col || col.source !== 'external' || !col.externalTable) return
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	await applyMediaStorage(items, col.externalTable, getMediaStorageMap(project))
}

/** Resolve a single content item's `relation` fields in place (default depth 1). */
async function hydrateRelations(
	app: FastifyInstance,
	projectId: string,
	item: Record<string, unknown>,
	depthParam: string | number | undefined,
) {
	const depth = depthParam === undefined ? 1 : Number(depthParam)
	if (!Number.isFinite(depth) || depth < 1) return
	const collectionId = item.collectionId as string | undefined
	if (!collectionId) return
	const [col] = await app.db
		.select()
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	if (!col) return
	await applyExternalMediaStorage(app, projectId, col, [item])
	await resolveRelations(app, projectId, [item], col.fields || [], depth)
}

export async function contentRoutes(app: FastifyInstance) {
	// List content (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const params = contentListSchema.parse(request.query)
		if (params.collectionId) {
			const access = await checkCollectionAccess(request, params.collectionId, 'read')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })
		}
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

		// When the requested collection is the media-backed collection, serve `media` rows
		// reshaped as content items (used by relation pickers that point at media).
		let collection: typeof collections.$inferSelect | undefined
		if (collectionId) {
			;[collection] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, collectionId), eq(collections.projectId, pid)))
				.limit(1)
			if (collection?.source === 'media') {
				const mediaWhere = eq(media.projectId, pid)
				const [mediaItems, mediaCount] = await Promise.all([
					app.db
						.select()
						.from(media)
						.where(mediaWhere)
						.orderBy(desc(media.createdAt))
						.limit(limit)
						.offset(offset),
					app.db.select({ count: sql<number>`count(*)` }).from(media).where(mediaWhere),
				])
				const mediaTotal = Number(mediaCount[0].count)
				return {
					data: mediaItems.map(mediaRowToContentItem),
					pagination: {
						page,
						limit,
						total: mediaTotal,
						totalPages: Math.ceil(mediaTotal / limit),
					},
				}
			}
		}

		const conditions = [eq(content.projectId, pid)]
		if (status) conditions.push(eq(content.status, status))
		if (collectionId) conditions.push(eq(content.collectionId, collectionId))
		// When the caller has no specific collectionId filter and is a restricted
		// editor/viewer, narrow the list to only their allowed collections so they
		// don't see content from collections they cannot access.
		if (
			!collectionId &&
			request.projectRole !== 'owner' &&
			request.projectRole !== 'admin' &&
			request.membershipId
		) {
			const access = await loadMemberCollectionAccess(app.db, request.membershipId)
			if (!access.unrestricted) {
				if (access.allowedIds.size === 0) {
					return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } }
				}
				conditions.push(inArray(content.collectionId, Array.from(access.allowedIds)))
			}
		}
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

		// Resolve the requested sort into an order expression. Real columns sort directly;
		// `meta:<field>` sorts on the JSONB metadata blob — text by default, or a guarded
		// numeric cast for number-typed fields (non-numeric rows become NULL → sorted last).
		// Anything unrecognized falls back to createdAt. A secondary id order keeps pagination
		// deterministic when the primary values tie.
		const realCols: Record<string, AnyColumn> = {
			createdAt: content.createdAt,
			updatedAt: content.updatedAt,
			publishedAt: content.publishedAt,
			slug: content.slug,
			status: content.status,
			locale: content.locale,
		}
		let primaryOrder = orderDir(content.createdAt)
		if (sortBy.startsWith('meta:')) {
			const field = sortBy.slice(5)
			const fieldDef =
				/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) && collection
					? collection.fields.find((f) => f.name === field)
					: undefined
			if (
				fieldDef &&
				['text', 'string', 'number', 'boolean', 'date', 'enum'].includes(fieldDef.type)
			) {
				const dir = sql.raw(sortOrder === 'asc' ? 'asc' : 'desc')
				// `field` passed the identifier regex above — same guarantee the metadata filter relies on.
				const key = sql.raw(`'${field}'`)
				const expr =
					fieldDef.type === 'number'
						? sql`CASE WHEN ${content.metadata}->>${key} ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (${content.metadata}->>${key})::numeric END`
						: sql`${content.metadata}->>${key}`
				primaryOrder = sql`${expr} ${dir} nulls last`
			}
		} else if (realCols[sortBy]) {
			primaryOrder = orderDir(realCols[sortBy])
		}

		const [items, countResult] = await Promise.all([
			app.db
				.select()
				.from(content)
				.where(where)
				.orderBy(primaryOrder, desc(content.id))
				.limit(limit)
				.offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(content).where(where),
		])

		// Live fallback: read directly from the external DB so the full collection
		// stays visible — either it has never been cached, or a background import
		// is still running (the partial cache would otherwise show only a subset).
		if (
			collectionId &&
			(Number(countResult[0].count) === 0 ||
				(collection?.source === 'external' && (await hasActiveImport(app, collectionId))))
		) {
			try {
				const live = await fetchLiveExternalContent(app, pid, collectionId, { limit, offset })
				if (live) {
					if (collection) {
						await applyExternalMediaStorage(app, pid, collection, live.items)
						await resolveRelations(app, pid, live.items, collection.fields || [], params.depth)
					}
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

		if (collection) {
			// Mirror the live-fallback path: a failure resolving relations or media
			// must degrade to raw rows, not 500 the whole list.
			try {
				await applyExternalMediaStorage(app, pid, collection, items as Record<string, unknown>[])
				await resolveRelations(
					app,
					pid,
					items as Record<string, unknown>[],
					collection.fields || [],
					params.depth,
				)
			} catch (err) {
				app.log.warn(err, 'Content list post-processing failed')
			}
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
	app.get<{ Params: { slug: string }; Querystring: { locale?: string; depth?: string } }>(
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

			await hydrateRelations(app, getProject(request).id, item, request.query.depth)

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
	app.get<{ Params: { id: string }; Querystring: { collectionId?: string; depth?: string } }>(
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
					const collectionId = request.query.collectionId
					const live = await fetchLiveExternalRecord(
						app,
						getProject(request).id,
						collectionId,
						request.params.id,
					)
					if (live) {
						await hydrateRelations(app, getProject(request).id, live.item, request.query.depth)
						// Priority caching: while a background import is still running,
						// promote the visited record into the cache ahead of the queue so
						// it is editable on the next load. Fire-and-forget so the response
						// is not delayed.
						if (await hasActiveImport(app, collectionId)) {
							cacheMissingDocs(app.db, content, [live.doc], {
								id: live.col.id,
								projectId: live.col.projectId,
								fields: live.col.fields || [],
							}).catch((err) => app.log.warn(err, 'Priority cache of visited record failed'))
						}
						return live.item
					}
				} catch (err) {
					app.log.warn(err, 'Live external record fallback failed')
				}
			}

			if (!item) return reply.status(404).send({ error: 'Content not found' })

			const access = await checkCollectionAccess(request, item.collectionId, 'read')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })

			await hydrateRelations(app, getProject(request).id, item, request.query.depth)

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
		const writeAccess = await checkCollectionAccess(request, input.collectionId, 'write')
		if (!writeAccess.ok) return reply.status(writeAccess.status).send({ error: writeAccess.error })
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

		// Only enforce the slug-uniqueness check when a slug is actually provided.
		// Null-slug rows (typically imported records without a source slug) all
		// coexist; their identity comes from `id`/`externalId` instead.
		if (input.slug) {
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
		}

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

		// Enforce per-collection write access across the batch (cheap dedupe by id).
		{
			const seen = new Set<string>()
			for (const item of items) {
				if (seen.has(item.collectionId)) continue
				seen.add(item.collectionId)
				const access = await checkCollectionAccess(request, item.collectionId, 'write')
				if (!access.ok) return reply.status(access.status).send({ error: access.error })
			}
		}

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
			const accessChecked = new Set<string>()
			for (const item of items) {
				const [current] = await tx
					.select()
					.from(content)
					.where(and(eq(content.id, item.id), eq(content.projectId, getProject(request).id)))
					.limit(1)
				if (!current) throw httpError(`Content not found: ${item.id}`, 404)
				if (!accessChecked.has(current.collectionId)) {
					accessChecked.add(current.collectionId)
					const access = await checkCollectionAccess(request, current.collectionId, 'write')
					if (!access.ok) throw httpError(access.error, access.status)
				}

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

				await tx.insert(contentVersions).values({
					contentId: current.id,
					version: current.version,
					markdown: current.markdown,
					metadata: current.metadata,
					createdBy: getUser(request).id,
				})

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
						version: current.version + 1,
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

			const writeAccess = await checkCollectionAccess(request, current.collectionId, 'write')
			if (!writeAccess.ok) {
				return reply.status(writeAccess.status).send({ error: writeAccess.error })
			}

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

	// Publish content directly (editor+, project-scoped). Distinct from the
	// review workflow's submit/approve dance: this is the single-step path used
	// when `settings.requireReview === false` OR the caller has been granted
	// `canPublishDirectly` on their membership. Not license-gated — direct
	// publish is a core capability; the review workflow is the premium add-on.
	app.post<{ Params: { id: string } }>(
		'/:id/publish',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			if (!request.canPublishDirectly) {
				return reply
					.status(403)
					.send({ error: 'Direct publish not allowed — submit for review instead.' })
			}

			const [item] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Content not found' })
			if (item.status === 'published') return item

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
				app.log.warn(err, 'Failed to sync direct publish to external DB')
				return reply.status(502).send({ error: 'Failed to sync to external database' })
			}

			const [updated] = await app.db
				.update(content)
				.set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:published',
				data: { id: updated.id, slug: updated.slug, projectId: getProject(request).id },
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)

	// Submit for review (editor+, project-scoped, license-gated)
	app.post<{ Params: { id: string } }>(
		'/:id/submit-for-review',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('review-workflows')] },
		async (request, reply) => {
			// If the caller can publish directly there's no point routing
			// through review — return a hint so the client can switch endpoints
			// rather than silently no-op'ing the user's intent.
			if (request.canPublishDirectly && !request.requireReview) {
				return reply.status(409).send({
					error: 'Review is disabled for this project — use POST /:id/publish instead.',
				})
			}

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

			// Media-backed collection: the `media` row was already created by /media/upload.
			// Look it up by the uploaded url and return its id as the relation reference.
			if (targetCol.source === 'media') {
				const url = values?.url
				if (typeof url !== 'string' || !url) {
					return reply.status(400).send({ error: 'url is required for a media relation record' })
				}
				const [row] = await app.db
					.select()
					.from(media)
					.where(and(eq(media.projectId, getProject(request).id), eq(media.url, url)))
					.orderBy(desc(media.createdAt))
					.limit(1)
				if (!row) return reply.status(404).send({ error: 'Media not found for the uploaded file' })
				return reply.status(201).send({ _id: row.id })
			}

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
