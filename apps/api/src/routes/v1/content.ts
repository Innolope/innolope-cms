import { contentInputSchema, contentListSchema } from '@innolope/config'
import { collections, content, contentAnalytics, contentVersions, media } from '@innolope/db'
import { type AnyColumn, and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
	checkCollectionAccess,
	resolveReadableCollectionScope,
} from '../../lib/collection-access.js'
import { mediaRowToContentItem, resolveRelations } from '../../lib/resolve-relations.js'
import { getUser } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'
import {
	contentValidationError,
	validateContentMetadata,
} from '../../services/content-validation.js'
import {
	applyExternalMediaStorage,
	buildExternalData,
	deleteFromExternalDb,
	fetchLiveExternalContent,
	fetchLiveExternalRecord,
	hasActiveImport,
	httpError,
	hydrateRelations,
	insertIntoExternalDb,
	renderMarkdown,
	syncExternalStatus,
	updateExternalDb,
} from '../../services/external-content.js'
import { cacheMissingDocs } from '../../services/markdown-cache.js'

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
		// When the caller has no specific collectionId filter, narrow the list to
		// the collections they may read (single source of truth for read scoping).
		if (!collectionId) {
			const scope = await resolveReadableCollectionScope(request)
			if (scope.scoped) {
				if (scope.allowedIds.length === 0) {
					return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } }
				}
				conditions.push(inArray(content.collectionId, scope.allowedIds))
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
					// Gate the live read the same way the cached path is gated below —
					// otherwise a restricted member could read an out-of-scope external
					// collection by falling through to the live fallback.
					const liveAccess = await checkCollectionAccess(request, collectionId, 'read')
					if (!liveAccess.ok) {
						return reply.status(liveAccess.status).send({ error: liveAccess.error })
					}
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
		const html = await renderMarkdown(input.markdown)
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

		// Validate metadata against the collection's field schema. Required fields
		// are enforced only when publishing; drafts may be incomplete. Extra keys
		// are ignored. On failure, echo the schema so the caller can self-correct.
		const createErrors = validateContentMetadata(col.fields, input.metadata, {
			enforceRequired: input.status === 'published',
		})
		if (createErrors.length > 0) {
			return reply.status(400).send(contentValidationError(col.fields, createErrors))
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
			// A slug that raced past the pre-check collides on the unique index
			// (Postgres 23505). Surface the intended 409 instead of a generic 500.
			if ((err as { cause?: { code?: string } })?.cause?.code === '23505') {
				return reply.status(409).send({ error: 'Content with this slug and locale already exists' })
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
		const { items, dryRun } = request.body as {
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
			dryRun?: boolean
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

		// Prefetch every referenced collection in one query instead of one per item.
		const createColIds = [...new Set(items.map((i) => i.collectionId))]
		const createCols = await app.db
			.select()
			.from(collections)
			.where(
				and(
					inArray(collections.id, createColIds),
					eq(collections.projectId, getProject(request).id),
				),
			)
		const createColMap = new Map(createCols.map((c) => [c.id, c]))

		// Validate the whole batch before writing anything, mirroring the single-item
		// create path (collection exists, writable, metadata matches the field schema).
		// Every bad item is reported — not just the first — so a caller can fix the
		// batch in one pass. The transaction below stays all-or-nothing.
		const itemErrors: Array<{
			index: number
			slug?: string
			errors: Array<{ field: string; message: string }>
		}> = []
		for (const [index, item] of items.entries()) {
			const col = createColMap.get(item.collectionId)
			if (!col) {
				itemErrors.push({
					index,
					slug: item.slug,
					errors: [
						{ field: 'collectionId', message: `Collection not found: ${item.collectionId}` },
					],
				})
				continue
			}
			if (col.source === 'external' && col.accessMode === 'read-only') {
				itemErrors.push({
					index,
					slug: item.slug,
					errors: [{ field: 'collectionId', message: `Collection is read-only: ${col.name}` }],
				})
				continue
			}
			const errors = validateContentMetadata(col.fields, item.metadata, {
				enforceRequired: item.status === 'published',
			})
			if (errors.length > 0) itemErrors.push({ index, slug: item.slug, errors })
		}

		// Duplicate-slug pre-check across the batch (the transaction re-checks, this
		// makes the report complete and lets dryRun catch conflicts without writing).
		const slugs = items.map((i) => i.slug).filter(Boolean)
		const existing = slugs.length
			? await app.db
					.select({ slug: content.slug, locale: content.locale })
					.from(content)
					.where(and(eq(content.projectId, getProject(request).id), inArray(content.slug, slugs)))
			: []
		const existingKeys = new Set(existing.map((r) => `${r.slug} ${r.locale}`))
		const batchKeys = new Set<string>()
		for (const [index, item] of items.entries()) {
			if (!item.slug) continue
			const key = `${item.slug} ${item.locale || 'en'}`
			const conflict = existingKeys.has(key)
				? 'Content with this slug and locale already exists'
				: batchKeys.has(key)
					? 'Duplicate slug within this batch'
					: null
			batchKeys.add(key)
			if (conflict) {
				itemErrors.push({ index, slug: item.slug, errors: [{ field: 'slug', message: conflict }] })
			}
		}
		itemErrors.sort((a, b) => a.index - b.index)

		// Echo the trimmed schema of each collection that had field errors so the
		// caller can self-correct (same idea as the single-create 400 body).
		const errorSchemas = () => {
			const ids = new Set(itemErrors.map((e) => items[e.index]?.collectionId).filter(Boolean))
			return Object.fromEntries(
				[...ids]
					.map((id) => createColMap.get(id as string))
					.filter((c): c is NonNullable<typeof c> => !!c)
					.map((c) => [
						c.id,
						c.fields.map((f) => ({
							name: f.name,
							type: f.type,
							required: !!f.required,
							...(f.options ? { options: f.options } : {}),
						})),
					]),
			)
		}

		if (dryRun) {
			return reply.send({
				dryRun: true,
				valid: items.length - new Set(itemErrors.map((e) => e.index)).size,
				total: items.length,
				errors: itemErrors,
				...(itemErrors.length > 0 && { schemas: errorSchemas() }),
			})
		}
		if (itemErrors.length > 0) {
			return reply.status(400).send({
				error: 'Some items failed validation — nothing was created',
				items: itemErrors,
				schemas: errorSchemas(),
			})
		}

		const insertedExternalRows: Array<{
			col: typeof collections.$inferSelect
			externalId: string
		}> = []
		let created: Array<typeof content.$inferSelect>
		try {
			created = await app.db.transaction(async (tx) => {
				const results = []
				for (const [index, item] of items.entries()) {
					const html = await renderMarkdown(item.markdown)
					const col = createColMap.get(item.collectionId)

					// Re-checked inside the transaction (the pre-flight pass above already
					// caught these) so a race can't slip through. Errors carry the item
					// index so an all-or-nothing rollback is still attributable.
					if (!col)
						throw httpError(`item ${index}: Collection not found: ${item.collectionId}`, 400)
					if (col.source === 'external' && col.accessMode === 'read-only') {
						throw httpError(`item ${index}: Collection is read-only: ${col.name}`, 403)
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
					if (duplicate)
						throw httpError(`item ${index}: Content with slug already exists: ${item.slug}`, 409)

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
		const { items, dryRun } = request.body as {
			items: Array<{
				id: string
				slug?: string
				markdown?: string
				metadata?: Record<string, unknown>
				status?: string
			}>
			dryRun?: boolean
		}

		if (!Array.isArray(items) || items.length === 0)
			return reply.status(400).send({ error: 'items array is required' })
		if (items.length > 50)
			return reply.status(400).send({ error: 'Maximum 50 items per bulk update' })

		// Prefetch the target rows and their collections in two queries rather than
		// two per item. Done before the transaction so the batch can be validated
		// (and dry-run) without touching the database.
		const updateIds = [...new Set(items.map((i) => i.id))]
		const currentRows = await app.db
			.select()
			.from(content)
			.where(and(inArray(content.id, updateIds), eq(content.projectId, getProject(request).id)))
		const currentMap = new Map(currentRows.map((r) => [r.id, r]))
		const updateColIds = [...new Set(currentRows.map((r) => r.collectionId))]
		const updateCols = updateColIds.length
			? await app.db
					.select()
					.from(collections)
					.where(
						and(
							inArray(collections.id, updateColIds),
							eq(collections.projectId, getProject(request).id),
						),
					)
			: []
		const updateColMap = new Map(updateCols.map((c) => [c.id, c]))

		// Validate the whole batch before writing, mirroring the single-item update
		// path: metadata is checked MERGED with the current row, required fields are
		// enforced only when the merged result is published. Every bad item is
		// reported; the transaction below stays all-or-nothing.
		const itemErrors: Array<{
			index: number
			id: string
			errors: Array<{ field: string; message: string }>
		}> = []
		for (const [index, item] of items.entries()) {
			const current = currentMap.get(item.id)
			if (!current) {
				itemErrors.push({
					index,
					id: item.id,
					errors: [{ field: 'id', message: `Content not found: ${item.id}` }],
				})
				continue
			}
			const col = updateColMap.get(current.collectionId)
			if (col?.source === 'external' && col.accessMode === 'read-only') {
				itemErrors.push({
					index,
					id: item.id,
					errors: [{ field: 'id', message: `Collection is read-only: ${col.name}` }],
				})
				continue
			}
			if (col) {
				const merged = { ...(current.metadata as Record<string, unknown>), ...item.metadata }
				const mergedStatus = item.status ?? current.status
				const errors = validateContentMetadata(col.fields, merged, {
					enforceRequired: mergedStatus === 'published',
				})
				if (errors.length > 0) itemErrors.push({ index, id: item.id, errors })
			}
		}

		if (dryRun) {
			return reply.send({
				dryRun: true,
				valid: items.length - new Set(itemErrors.map((e) => e.index)).size,
				total: items.length,
				errors: itemErrors,
			})
		}
		if (itemErrors.length > 0) {
			return reply.status(400).send({
				error: 'Some items failed validation — nothing was updated',
				items: itemErrors,
			})
		}

		const updated = await app.db.transaction(async (tx) => {
			const results = []
			const accessChecked = new Set<string>()

			for (const [index, item] of items.entries()) {
				const current = currentMap.get(item.id)
				if (!current) throw httpError(`item ${index}: Content not found: ${item.id}`, 404)
				if (!accessChecked.has(current.collectionId)) {
					accessChecked.add(current.collectionId)
					const access = await checkCollectionAccess(request, current.collectionId, 'write')
					if (!access.ok) throw httpError(`item ${index}: ${access.error}`, access.status)
				}

				const col = updateColMap.get(current.collectionId)

				let externalId = current.externalId
				if (col?.source === 'external' && col.accessMode === 'read-only') {
					throw httpError(`item ${index}: Collection is read-only: ${col.name}`, 403)
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

				const html = item.markdown ? await renderMarkdown(item.markdown) : undefined
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
	app.post(
		'/query-by-fields',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
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
			if (collectionId) {
				// A specific collection was requested — gate it exactly like GET /:id does.
				const access = await checkCollectionAccess(request, collectionId, 'read')
				if (!access.ok) return reply.status(access.status).send({ error: access.error })
				conditions.push(eq(content.collectionId, collectionId))
			} else {
				// No collection filter: narrow to the collections this member may read.
				const scope = await resolveReadableCollectionScope(request)
				if (scope.scoped) {
					if (scope.allowedIds.length === 0) {
						return { data: [], pagination: { page: Number(page), limit: Number(limit), total: 0 } }
					}
					conditions.push(inArray(content.collectionId, scope.allowedIds))
				}
			}

			// Add JSONB field filters (field names validated to prevent injection).
			// Invalid names are a hard 400 — silently dropping a filter would run the
			// query broader than the caller asked for.
			const invalidFilterKeys = Object.keys(filters || {}).filter(
				(field) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field),
			)
			if (invalidFilterKeys.length > 0) {
				return reply.status(400).send({
					error: `Invalid filter field name(s): ${invalidFilterKeys.join(', ')}. Names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ — check the collection schema via get_collection_schema.`,
				})
			}
			for (const [field, value] of Object.entries(filters || {})) {
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
				pagination: {
					page: Number(page),
					limit: Number(limit),
					total: Number(countResult[0].count),
				},
			}
		},
	)

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

			// Validate the post-update metadata against the schema (required enforced
			// only when the result is published). Uses the merged view so a partial
			// update isn't judged as if it replaced everything.
			if (col) {
				const mergedMetadata = { ...current.metadata, ...input.metadata }
				const nextStatus = input.status ?? current.status
				const updateErrors = validateContentMetadata(col.fields, mergedMetadata, {
					enforceRequired: nextStatus === 'published',
				})
				if (updateErrors.length > 0) {
					return reply.status(400).send(contentValidationError(col.fields, updateErrors))
				}
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

			const html = input.markdown ? await renderMarkdown(input.markdown) : undefined
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
	app.delete<{ Params: { id: string }; Querystring: { collectionId?: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			// Resolve the id the same three ways GET /:id does: local uuid, then the
			// external id of a cached row, then a live external record (uncached —
			// requires ?collectionId, like the GET live fallback). A non-UUID id makes
			// the uuid-typed comparison throw — treat that as "not found locally".
			let deleted: typeof content.$inferSelect | undefined
			try {
				;[deleted] = await app.db
					.delete(content)
					.where(
						and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
					)
					.returning()
			} catch {
				deleted = undefined
			}

			if (!deleted) {
				;[deleted] = await app.db
					.delete(content)
					.where(
						and(
							eq(content.externalId, request.params.id),
							eq(content.projectId, getProject(request).id),
						),
					)
					.returning()
			}

			// Live external record with no cached CMS row: delete straight from the
			// external database. Existence is checked first so a wrong id is a 404,
			// not a silent no-op delete.
			if (!deleted && request.query.collectionId) {
				const access = await checkCollectionAccess(request, request.query.collectionId, 'write')
				if (!access.ok) return reply.status(access.status).send({ error: access.error })
				const [liveCol] = await app.db
					.select()
					.from(collections)
					.where(
						and(
							eq(collections.id, request.query.collectionId),
							eq(collections.projectId, getProject(request).id),
						),
					)
					.limit(1)
				if (!liveCol) return reply.status(404).send({ error: 'Collection not found' })
				if (liveCol.source !== 'external' || !liveCol.externalTable) {
					return reply.status(404).send({ error: 'Content not found' })
				}
				if (liveCol.accessMode === 'read-only') {
					return reply.status(403).send({ error: 'This collection is read-only' })
				}
				const live = await fetchLiveExternalRecord(
					app,
					getProject(request).id,
					liveCol.id,
					request.params.id,
				).catch(() => null)
				if (!live) return reply.status(404).send({ error: 'Content not found' })
				try {
					await deleteFromExternalDb(app, getProject(request).id, liveCol, request.params.id)
				} catch (err) {
					app.log.error(err, 'Failed to delete live external record')
					return reply.status(502).send({ error: 'Failed to delete from external database' })
				}
				app.events.emit({
					type: 'content:deleted',
					data: {
						id: request.params.id,
						slug: live.item.slug ?? null,
						projectId: getProject(request).id,
					},
					timestamp: new Date().toISOString(),
				})
				return reply.status(204).send()
			}

			if (!deleted) return reply.status(404).send({ error: 'Content not found' })

			// Propagate the delete to the external DB when this row was backed by one,
			// so external collections don't accumulate orphaned documents. The CMS row
			// is already gone, so a failure here can't fail the request (no 5xx) — but
			// it must not be silent either: the caller gets a 200 warning payload so it
			// knows the external record dangles and needs manual cleanup.
			let externalCleanupError: string | undefined
			let externalTable: string | undefined
			if (deleted.externalId) {
				const [col] = await app.db
					.select()
					.from(collections)
					.where(
						and(
							eq(collections.id, deleted.collectionId),
							eq(collections.projectId, getProject(request).id),
						),
					)
					.limit(1)
				if (col?.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
					externalTable = col.externalTable
					try {
						await deleteFromExternalDb(app, getProject(request).id, col, deleted.externalId)
					} catch (err) {
						app.log.error(err, 'Failed to delete external row after CMS delete')
						externalCleanupError = err instanceof Error ? err.message : String(err)
					}
				}
			}

			app.events.emit({
				type: 'content:deleted',
				data: { id: deleted.id, slug: deleted.slug, projectId: getProject(request).id },
				timestamp: new Date().toISOString(),
			})

			if (externalCleanupError) {
				return reply.status(200).send({
					deleted: true,
					externalCleanup: 'failed',
					message: `The content item was deleted from the CMS, but removing the backing record (id ${deleted.externalId}) from the external table "${externalTable}" failed: ${externalCleanupError}. Delete it there manually to avoid an orphaned row.`,
				})
			}
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

			const html = await renderMarkdown(version.markdown)
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
				.select({ id: content.id, collectionId: content.collectionId })
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)
			if (!item) return reply.status(404).send({ error: 'Content not found' })

			// Restricted members must not read version history of collections they
			// cannot access — same gate as GET /:id.
			const access = await checkCollectionAccess(request, item.collectionId, 'read')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })

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

			// Publishing is the point where required fields must all be present.
			const [pubCol] = await app.db
				.select()
				.from(collections)
				.where(
					and(
						eq(collections.id, item.collectionId),
						eq(collections.projectId, getProject(request).id),
					),
				)
				.limit(1)
			if (pubCol) {
				const pubErrors = validateContentMetadata(
					pubCol.fields,
					item.metadata as Record<string, unknown>,
					{ enforceRequired: true },
				)
				if (pubErrors.length > 0) {
					return reply.status(400).send(contentValidationError(pubCol.fields, pubErrors))
				}
			}

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
