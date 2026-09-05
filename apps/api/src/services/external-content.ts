import {
	type CollectionField,
	externalStatusSupport,
	isSchemalessExternalDb,
} from '@innolope/config'
import { collections, importJobs, projects } from '@innolope/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { createExternalDbAdapter, type ExternalDocument } from '../adapters/external-db.js'
import { applyMediaStorage, getMediaStorageMap } from '../lib/media-storage.js'
import { resolveRelations } from '../lib/resolve-relations.js'
import { BODY_FIELD_NAMES } from './localized-fields.js'
import { externalDocToContentItem } from './markdown-cache.js'

export function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html)
}

/**
 * Single markdown→HTML pipeline for stored content. Every write path must go
 * through this so the parse + sanitize configuration can never diverge between
 * create, update, bulk, and version-restore (a divergence would be a stored-XSS
 * vector). Returns sanitized HTML.
 */
export async function renderMarkdown(markdown: string): Promise<string> {
	return sanitizeHtml(await marked(markdown))
}

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

export function buildExternalData(
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
		// The source primary key is never an author-settable field, even on a
		// schemaless collection where every other key passes through.
		if (key === '_id' || key.startsWith('$')) continue
		if (fieldNames.size === 0 || fieldNames.has(key)) {
			data[key] = coerceExternalFieldValue(fields.find((field) => field.name === key)?.type, value)
		}
	}

	// Always carry the slug when one was provided. Whether it may actually be
	// written depends on the TARGET database, which this builder doesn't know:
	// schemaless MongoDB must always receive it (a collection with a non-sparse
	// unique `slug_1` index otherwise gets `null`/missing on every insert and the
	// second write collides with a duplicate-key error — this happened even for
	// introspected collections whose sampled docs didn't surface a `slug` field),
	// while SQL breaks on unknown columns. `stripUnmappedSystemColumns` applies that
	// type-aware decision in insertIntoExternalDb/updateExternalDb.
	if (input.slug) data.slug = input.slug

	// `status` follows the same rule, for a sharper reason: without it on the source
	// row a draft is not a draft. The site reads the source database directly, so a
	// record the CMS considers unpublished stays visible to every reader until the
	// status lands next to it. Carried unconditionally; `stripUnmappedSystemColumns`
	// takes it back off again for SQL targets that have no such column.
	if (input.status) {
		data.status = coerceExternalFieldValue(
			fields.find((field) => field.name === 'status')?.type,
			input.status,
		)
	}

	// The body column. Same precedence rule as the timestamps below: an explicit
	// value in `metadata` wins. That is what protects a localized body — the editor
	// sends `content: { en, ua }` in metadata while `markdown` only carries the
	// flattened preview copy, and writing that back would collapse the locale map
	// to a single string in the source database.
	const bodyField = BODY_FIELD_NAMES.find((field) => fieldNames.has(field))
	if (bodyField && input.markdown !== undefined && !(bodyField in data)) {
		data[bodyField] = input.markdown
	}

	// Creation and edit times are informational: the source table usually keeps its
	// own, and adding an `updatedAt` key that was never there also perturbs the
	// watermark `detectCursorColumn` picks on the next re-scan. So they are stamped
	// only when the collection actually maps them, and only as a fallback — a value
	// the user supplied via metadata is already in `data` and wins.
	const declaredTimestamps: Record<string, string | Date | null | undefined> = {
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
	}
	for (const [fieldName, value] of Object.entries(declaredTimestamps)) {
		if (value !== undefined && fieldNames.has(fieldName) && !(fieldName in data)) {
			data[fieldName] = coerceExternalFieldValue(
				fields.find((field) => field.name === fieldName)?.type,
				value,
			)
		}
	}

	// `publishedAt` is lifecycle, not decoration — it is the date a scheduled post
	// goes live and the one a site orders its feed by, so it travels with `status`
	// rather than with the two above. Undeclared columns get a real Date: nothing
	// has written this key before, and a native date is what a Mongo query wants.
	if (input.publishedAt !== undefined && !('publishedAt' in data)) {
		const declared = fields.find((field) => field.name === 'publishedAt')
		data.publishedAt = declared
			? coerceExternalFieldValue(declared.type, input.publishedAt)
			: toExternalDate(input.publishedAt)
	}

	return data
}

/** Normalize a lifecycle timestamp to a real Date for a column nothing declared. */
function toExternalDate(value: string | Date | null): Date | null {
	if (value === null) return null
	if (value instanceof Date) return value
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? null : date
}

/** Lifecycle timestamps `buildExternalData` may stamp onto the external row. */
const EXTERNAL_TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'publishedAt'] as const

/**
 * Fold the timestamps that actually reached the external database back into the
 * metadata the CMS caches locally.
 *
 * The cached row stores `metadata` straight from the request body, but
 * `buildExternalData` stamps `createdAt`/`updatedAt`/`publishedAt` on top when the
 * collection maps them and the caller didn't supply one. Without this merge the two
 * diverge and the editor renders those fields blank for every record the CMS itself
 * created — even though the external document has them.
 *
 * Only *declared* columns are folded back. `publishedAt` is now carried to
 * schemaless targets whether or not the schema knows about it, and caching a value
 * that a SQL target stripped on the way out would make every subsequent
 * sync-preview report the row as changed.
 */
export function mergeExternalTimestamps(
	metadata: Record<string, unknown> | undefined,
	externalData: Record<string, unknown>,
	fields: CollectionField[] | null | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(metadata ?? {}) }
	const declared = new Set((fields ?? []).map((field) => field.name))
	for (const key of EXTERNAL_TIMESTAMP_FIELDS) {
		if (!declared.has(key)) continue
		if (!(key in externalData)) continue
		const value = externalData[key]
		// The cache column is JSONB — normalize Dates so a round-trip stays a string.
		merged[key] = value instanceof Date ? value.toISOString() : value
	}
	return merged
}

function coerceExternalFieldValue(fieldType: string | undefined, value: unknown): unknown {
	if (value === null || value === undefined) return value
	// A column the source stores as an ISO string (very common for Mongo documents
	// written by an ORM) must keep receiving strings. Writing a Date into it instead
	// leaves the column holding both BSON types, and BSON sorts every String before
	// every Date — which silently reorders a feed the moment the CMS touches a row.
	if (fieldType === 'text') return value instanceof Date ? value.toISOString() : value
	if (fieldType !== 'date') return value
	if (value instanceof Date) return value
	if (typeof value === 'string' || typeof value === 'number') {
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? value : date
	}
	return value
}

/**
 * System columns the CMS owns and carries to the source row even when the detected
 * schema never declared them. Each is load-bearing for something the site does:
 * `slug` for permalinks and Mongo's unique index, `status` for hiding unpublished
 * records, `publishedAt` for ordering the feed.
 */
const IMPLICIT_SYSTEM_COLUMNS = ['slug', 'status', 'publishedAt'] as const

/**
 * Drop the system columns a target can't take.
 *
 * SQL databases error on a column that doesn't exist, so these survive only when
 * the collection actually maps them. MongoDB is schemaless and takes them all —
 * for `slug` that is load-bearing (see the comment in buildExternalData), and for
 * `status` it is the whole reason an external draft can be hidden at all.
 */
export function stripUnmappedSystemColumns(
	dbType: string,
	col: typeof collections.$inferSelect,
	data: Record<string, unknown>,
): Record<string, unknown> {
	if (isSchemalessExternalDb(dbType)) return data
	const declared = new Set((col.fields || []).map((field) => field.name))
	const out = { ...data }
	for (const key of IMPLICIT_SYSTEM_COLUMNS) {
		if (key in out && !declared.has(key)) delete out[key]
	}
	return out
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

export async function insertIntoExternalDb(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect,
	data: Record<string, unknown>,
) {
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb || !col.externalTable) throw new Error('External database is not configured')

	const payload = await coerceExternalRelations(
		extDb.type,
		col,
		stripUnmappedSystemColumns(extDb.type, col, data),
	)
	if (Object.keys(payload).length === 0) return null

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		return await adapter.insert(col.externalTable, payload)
	} finally {
		await adapter.disconnect()
	}
}

export async function updateExternalDb(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect,
	externalId: string,
	data: Record<string, unknown>,
) {
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb || !col.externalTable) throw new Error('External database is not configured')

	const payload = await coerceExternalRelations(
		extDb.type,
		col,
		stripUnmappedSystemColumns(extDb.type, col, data),
	)
	// Nothing this target can accept. Mongo rejects `{ $set: {} }` outright and a
	// SQL UPDATE with no SET clause is a syntax error, so an unguarded empty payload
	// turns a no-op into a 502 — which is how a status sync to a collection with no
	// status column used to fail.
	if (Object.keys(payload).length === 0) return null

	const adapter = createExternalDbAdapter(extDb)
	await adapter.connect()
	try {
		return await adapter.update(col.externalTable, externalId, payload)
	} finally {
		await adapter.disconnect()
	}
}

export async function deleteFromExternalDb(
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

export function httpError(message: string, statusCode: number) {
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
	if (col?.source !== 'external' || !col.externalTable) return null

	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const extDb = getExternalDbConfig(project)
	if (!extDb) return null

	return { col, extDb }
}

/** True while a background import for this collection is queued or running. */
export async function hasActiveImport(
	app: FastifyInstance,
	collectionId: string,
): Promise<boolean> {
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

/**
 * Why a status change did or didn't reach the source row.
 *
 * `unsupported` is the one callers must not treat as an error: the CMS row still
 * flips, the site just can't see it. Reporting it lets the editor say so instead
 * of leaving an author to discover their draft on the live site.
 */
export type StatusSyncOutcome =
	| { synced: true }
	| { synced: false; reason: 'not-external' | 'no-external-id' | 'unsupported' }

/** Push a status change to the external DB row, if the collection is an external read-write source. */
export async function syncExternalStatus(
	app: FastifyInstance,
	projectId: string,
	collectionId: string,
	externalId: string | null,
	status: string,
	publishedAt: Date | null,
): Promise<StatusSyncOutcome> {
	const [col] = await app.db
		.select()
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	if (col?.source !== 'external' || col.accessMode !== 'read-write' || !col.externalTable) {
		return { synced: false, reason: 'not-external' }
	}
	if (!externalId) return { synced: false, reason: 'no-external-id' }

	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const support = externalStatusSupport({
		source: col.source,
		accessMode: col.accessMode,
		fields: col.fields,
		dbType: getExternalDbConfig(project)?.type,
	})
	// A SQL table with no `status` column cannot record this, and attempting the
	// write would send an empty UPDATE. Say so rather than failing the request.
	if (!support.supported) return { synced: false, reason: 'unsupported' }

	const data = buildExternalData(col, { status, publishedAt })
	await updateExternalDb(app, projectId, col, externalId, data)
	return { synced: true }
}

/** Fetch a page of records live from the external DB (used when the local cache is empty). */
export async function fetchLiveExternalContent(
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
export async function fetchLiveExternalRecord(
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
export async function applyExternalMediaStorage(
	app: FastifyInstance,
	projectId: string,
	col: typeof collections.$inferSelect | undefined,
	items: Array<{ metadata?: Record<string, unknown> }>,
) {
	if (col?.source !== 'external' || !col.externalTable) return
	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	await applyMediaStorage(items, col.externalTable, getMediaStorageMap(project))
}

/** Resolve a single content item's `relation` fields in place (default depth 1). */
export async function hydrateRelations(
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
