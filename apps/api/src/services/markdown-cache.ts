interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
}

import type { collections, content, contentVersions, Database } from '@innolope/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { ExternalDbAdapter, ExternalDocument } from '../adapters/external-db.js'

/**
 * Source-table column names checked (in order) when auto-detecting an
 * incremental-sync watermark. A field qualifies only if it's typed `date` on
 * the collection — anything else won't be a monotonic source of truth.
 */
const CURSOR_COLUMN_CANDIDATES = [
	'updated_at',
	'updatedAt',
	'modifiedAt',
	'modified_at',
	'lastModified',
	'last_modified',
	'modified',
	'_ts',
] as const

/** Pick a date-typed field name to use as the incremental cursor, if one exists. */
export function detectCursorColumn(fields: CollectionField[]): string | undefined {
	const dateNames = fields.filter((f) => f.type === 'date').map((f) => f.name)
	const dateSet = new Set(dateNames)
	const lowerMap = new Map(dateNames.map((n) => [n.toLowerCase(), n]))
	for (const cand of CURSOR_COLUMN_CANDIDATES) {
		if (dateSet.has(cand)) return cand
		const hit = lowerMap.get(cand.toLowerCase())
		if (hit) return hit
	}
	return undefined
}

/** Postgres `unique_violation` — the row already exists under a colliding slug. */
function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

const VALID_STATUSES = new Set(['draft', 'pending_review', 'published', 'archived'])
type ContentStatus = 'draft' | 'pending_review' | 'published' | 'archived'
type ContentTable = typeof content
type SyncOptions = {
	batchSize?: number
	userId?: string
	versionTable?: typeof contentVersions
	/** Required to persist the sync watermark + auto-detected cursor column. */
	collectionsTable?: typeof collections
}

export interface SyncCollectionRef {
	id: string
	projectId: string
	externalTable: string
	fields: CollectionField[]
	/** Pre-set column name to use as the incremental cursor. Falls back to auto-detect. */
	cursorColumn?: string | null
	/** Highest cursor value seen in the previous sync. Filters source-side. */
	lastSyncedCursor?: Date | null
}
type CachedContentValues = {
	projectId: string
	collectionId: string
	metadata: Record<string, unknown>
	markdown: string
	html: string
	externalId: string
	status: ContentStatus
	locale: string
	createdBy: string | null
	createdAt?: Date
	updatedAt: Date
	publishedAt?: Date
}

export interface SyncChange {
	field: string
	local: unknown
	external: unknown
}

export interface SyncPreviewItem {
	externalId: string
	contentId?: string
	/** Null when the source row has no title/name/slug-bearing field. */
	slug: string | null
	changeType: 'created' | 'updated'
	changes: SyncChange[]
}

/**
 * Recursively remove NUL (`\u0000`) bytes from every string in a value. Postgres
 * `text`/`jsonb` cannot store NUL — a single source record carrying one (common
 * in data migrated out of MongoDB) makes the whole 100-row import batch fail with
 * `22P05: unsupported Unicode escape sequence`. Dates and other non-plain objects
 * are returned untouched.
 */
function stripNullBytes<T>(value: T): T {
	if (typeof value === 'string') {
		return (value.includes('\u0000') ? value.replace(/\u0000/g, '') : value) as T
	}
	if (Array.isArray(value)) return value.map(stripNullBytes) as T
	if (value !== null && typeof value === 'object' && value.constructor === Object) {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value)) out[k] = stripNullBytes(v)
		return out as T
	}
	return value
}

/** Convert an external document to markdown with YAML frontmatter */
export function documentToMarkdown(
	doc: ExternalDocument,
	fields: CollectionField[],
): { markdown: string; metadata: Record<string, unknown> } {
	const bodyField = findBodyField(doc, fields)
	const metadata: Record<string, unknown> = {}
	let bodyContent = ''

	for (const [key, value] of Object.entries(doc)) {
		if (key === '_id') continue
		if (key === bodyField) {
			bodyContent = stripNullBytes(String(value ?? ''))
		} else {
			metadata[key] = stripNullBytes(value)
		}
	}

	const frontmatter = Object.entries(metadata)
		.map(([k, v]) => `${k}: ${formatYamlValue(v)}`)
		.join('\n')

	const markdown = frontmatter ? `---\n${frontmatter}\n---\n\n${bodyContent}` : bodyContent

	return { markdown, metadata }
}

/** Find the most likely "body" field in a document */
function findBodyField(doc: ExternalDocument, _fields: CollectionField[]): string | null {
	const bodyNames = ['content', 'body', 'description', 'text', 'markdown', 'html']
	for (const name of bodyNames) {
		if (doc[name] && typeof doc[name] === 'string' && (doc[name] as string).length > 100)
			return name
	}
	let longest = ''
	let longestKey: string | null = null
	for (const [key, value] of Object.entries(doc)) {
		if (key === '_id') continue
		if (typeof value === 'string' && value.length > longest.length) {
			longest = value
			longestKey = key
		}
	}
	return longestKey && longest.length > 100 ? longestKey : null
}

function formatYamlValue(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') {
		if (value.includes('\n') || value.includes(':') || value.includes('"')) {
			return `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
		}
		return value
	}
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (value instanceof Date) return value.toISOString()
	if (Array.isArray(value)) return `[${value.map((v) => formatYamlValue(v)).join(', ')}]`
	return JSON.stringify(value)
}

/**
 * The slug of an imported row is the source `slug` field, used verbatim. We do
 * NOT fabricate one from `title`/`name`, and we do NOT append an id suffix — a
 * slug that isn't in the source is not ours to invent. Returns null when the
 * source row has no slug; the DB column stores that as-is (it's nullable).
 */
function slugFromDoc(metadata: Record<string, unknown>): string | null {
	const raw = metadata.slug
	if (typeof raw === 'string') return raw.trim() || null
	if (typeof raw === 'number') return String(raw)
	return null
}

/** Populate markdown cache for all documents in an external collection */
export async function populateMarkdownCache(
	db: Database,
	contentTable: ContentTable,
	adapter: ExternalDbAdapter,
	collection: {
		id: string
		projectId: string
		externalTable: string
		fields: CollectionField[]
	},
	opts: SyncOptions = {},
): Promise<number> {
	const result = await syncMarkdownCache(db, contentTable, adapter, collection, opts)
	return result.created
}

export interface SyncResult {
	created: number
	updated: number
	/** `incremental` when a prior watermark filtered the scan; `full` otherwise. */
	mode: 'full' | 'incremental'
	/** Column used as the cursor for this run; null when no candidate was found. */
	cursorColumn: string | null
	/** Highest cursor value seen this run — the next sync should start above this. */
	newCursor: Date | null
}

/** Refresh cached CMS rows from an external collection. External documents are the source of truth. */
export async function syncMarkdownCache(
	db: Database,
	contentTable: ContentTable,
	adapter: ExternalDbAdapter,
	collection: SyncCollectionRef,
	opts: SyncOptions = {},
): Promise<SyncResult> {
	const batchSize = opts.batchSize || 100
	const cursorColumn = collection.cursorColumn ?? detectCursorColumn(collection.fields) ?? null
	const cursorAfter =
		cursorColumn && collection.lastSyncedCursor ? collection.lastSyncedCursor : undefined
	const mode: 'full' | 'incremental' = cursorAfter ? 'incremental' : 'full'

	let offset = 0
	let created = 0
	let updated = 0
	let newCursor: Date | null = collection.lastSyncedCursor ?? null

	while (true) {
		const docs = await adapter.findAll(collection.externalTable, {
			limit: batchSize,
			offset,
			cursorColumn: cursorColumn ?? undefined,
			cursorAfter,
		})
		if (docs.length === 0) break

		if (cursorColumn) {
			for (const doc of docs) {
				const seen = toDate(doc[cursorColumn])
				if (seen && (!newCursor || seen > newCursor)) newCursor = seen
			}
		}

		const result = await applySyncBatch(db, contentTable, docs, collection, opts)
		created += result.created
		updated += result.updated

		offset += batchSize
		if (docs.length < batchSize) break
	}

	if (opts.collectionsTable) {
		const updates: Partial<typeof collections.$inferInsert> = {
			lastSyncedAt: new Date(),
			updatedAt: new Date(),
		}
		if (newCursor) updates.lastSyncedCursor = newCursor
		// Persist the auto-detected cursor column so future syncs skip detection
		// and surface the choice to the admin UI.
		if (cursorColumn && !collection.cursorColumn) updates.cursorColumn = cursorColumn
		await db
			.update(opts.collectionsTable)
			.set(updates)
			.where(eq(opts.collectionsTable.id, collection.id))
	}

	return { created, updated, mode, cursorColumn, newCursor }
}

/**
 * Apply one batch of source docs to the local cache: one lookup, one bulk
 * insert for new rows, one bulk versions insert, and parallel updates only for
 * rows whose materialized state actually changed. Replaces the previous
 * per-doc SELECT + INSERT/UPDATE loop (200 round-trips per 100-row batch).
 */
async function applySyncBatch(
	db: Database,
	contentTable: ContentTable,
	docs: ExternalDocument[],
	collection: {
		id: string
		projectId: string
		fields: CollectionField[]
	},
	opts: SyncOptions,
): Promise<{ created: number; updated: number }> {
	if (docs.length === 0) return { created: 0, updated: 0 }

	const externalIds = docs.map((d) => d._id)
	const existingRows = await db
		.select()
		.from(contentTable)
		.where(
			and(
				eq(contentTable.projectId, collection.projectId),
				eq(contentTable.collectionId, collection.id),
				inArray(contentTable.externalId, externalIds),
			),
		)
	const existingByExternalId = new Map(
		existingRows.map((r) => [r.externalId as string, r] as const),
	)

	const toInsert: Array<CachedContentValues & { slug: string | null }> = []
	const toUpdate: Array<{ existing: (typeof existingRows)[number]; next: CachedContentValues }> = []

	for (const doc of docs) {
		const { values, slug } = buildCachedContentValues(doc, collection, opts)
		const existing = existingByExternalId.get(doc._id)
		if (existing) {
			if (diffCachedContent(existing, values).length > 0) {
				toUpdate.push({ existing, next: values })
			}
		} else {
			toInsert.push({ ...values, slug })
		}
	}

	let createdCount = 0
	if (toInsert.length > 0) {
		// onConflictDoNothing absorbs the rare slug race (two docs hash to the
		// same slug); .returning gives us the accurate post-conflict count.
		const inserted = await db
			.insert(contentTable)
			.values(toInsert)
			.onConflictDoNothing()
			.returning({ id: contentTable.id })
		createdCount = inserted.length
	}

	if (toUpdate.length > 0 && opts.versionTable) {
		await db.insert(opts.versionTable).values(
			toUpdate.map(({ existing }) => ({
				contentId: existing.id,
				version: existing.version,
				markdown: existing.markdown,
				metadata: existing.metadata,
				createdBy: opts.userId || null,
			})),
		)
	}

	// Updates can't be merged into a single statement (each row gets distinct
	// values), so fan them out across the pool in small chunks to stay under
	// the default connection limit.
	await runInChunks(toUpdate, 10, async ({ existing, next }) => {
		try {
			await db
				.update(contentTable)
				.set({ ...next, version: (existing.version || 1) + 1 })
				.where(eq(contentTable.id, existing.id))
		} catch (err) {
			// Slug isn't changed by sync updates so this should be unreachable —
			// but a metadata-driven slug change would surface as unique_violation
			// and was tolerated by the previous loop. Preserve that.
			if (!isUniqueViolation(err)) throw err
		}
	})

	return { created: createdCount, updated: toUpdate.length }
}

async function runInChunks<T>(
	items: T[],
	chunkSize: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	for (let i = 0; i < items.length; i += chunkSize) {
		await Promise.all(items.slice(i, i + chunkSize).map(fn))
	}
}

/**
 * Cache the external docs that are not yet in the local `content` table, in a
 * handful of queries (one existence lookup + one bulk insert per call). Never
 * overwrites an existing row, so records the user already opened or edited
 * mid-import are left intact. Idempotent — safe to re-run on the same batch.
 * Returns the number of rows inserted.
 */
export async function cacheMissingDocs(
	db: Database,
	contentTable: ContentTable,
	docs: ExternalDocument[],
	collection: {
		id: string
		projectId: string
		fields: CollectionField[]
	},
	opts: Pick<SyncOptions, 'userId'> = {},
): Promise<number> {
	if (docs.length === 0) return 0

	const existing = await db
		.select({ externalId: contentTable.externalId })
		.from(contentTable)
		.where(
			and(
				eq(contentTable.projectId, collection.projectId),
				eq(contentTable.collectionId, collection.id),
				inArray(
					contentTable.externalId,
					docs.map((doc) => doc._id),
				),
			),
		)
	const cached = new Set(existing.map((row) => row.externalId))

	const rows = docs
		.filter((doc) => !cached.has(doc._id))
		.map((doc) => {
			const { values, slug } = buildCachedContentValues(doc, collection, opts)
			return { ...values, slug }
		})
	if (rows.length === 0) return 0

	// onConflictDoNothing skips the rare colliding slug — and makes a re-run of a
	// partially-applied batch (after a worker restart) harmless.
	const inserted = await db
		.insert(contentTable)
		.values(rows)
		.onConflictDoNothing()
		.returning({ id: contentTable.id })
	return inserted.length
}

/** Compare cached CMS rows with the external source before applying a sync. */
export async function previewMarkdownCacheSync(
	db: Database,
	contentTable: ContentTable,
	adapter: ExternalDbAdapter,
	collection: SyncCollectionRef,
	opts: { batchSize?: number; limit?: number } = {},
): Promise<{ discrepancies: SyncPreviewItem[]; total: number }> {
	const batchSize = opts.batchSize || 100
	const limit = opts.limit || 25
	const cursorColumn = collection.cursorColumn ?? detectCursorColumn(collection.fields) ?? null
	const cursorAfter =
		cursorColumn && collection.lastSyncedCursor ? collection.lastSyncedCursor : undefined
	let offset = 0
	let total = 0
	const discrepancies: SyncPreviewItem[] = []

	while (true) {
		const docs = await adapter.findAll(collection.externalTable, {
			limit: batchSize,
			offset,
			cursorColumn: cursorColumn ?? undefined,
			cursorAfter,
		})
		if (docs.length === 0) break

		const externalIds = docs.map((d) => d._id)
		const existingRows = await db
			.select()
			.from(contentTable)
			.where(
				and(
					eq(contentTable.projectId, collection.projectId),
					eq(contentTable.collectionId, collection.id),
					inArray(contentTable.externalId, externalIds),
				),
			)
		const existingByExternalId = new Map(
			existingRows.map((r) => [r.externalId as string, r] as const),
		)

		for (const doc of docs) {
			const { values, slug } = buildCachedContentValues(doc, collection, {})
			const existing = existingByExternalId.get(doc._id)

			if (!existing) {
				total++
				if (discrepancies.length < limit) {
					discrepancies.push({
						externalId: doc._id,
						slug,
						changeType: 'created',
						changes: [{ field: 'content', local: null, external: 'new external row' }],
					})
				}
				continue
			}

			const changes = diffCachedContent(existing, values)
			if (changes.length > 0) {
				total++
				if (discrepancies.length < limit) {
					discrepancies.push({
						externalId: doc._id,
						contentId: existing.id,
						slug: existing.slug,
						changeType: 'updated',
						changes,
					})
				}
			}
		}

		offset += batchSize
		if (docs.length < batchSize) break
	}

	return { discrepancies, total }
}

/** Basic markdown→HTML conversion used for cached/live rows. */
function markdownToBasicHtml(markdown: string): string {
	return markdown
		.replace(/^### (.*$)/gm, '<h3>$1</h3>')
		.replace(/^## (.*$)/gm, '<h2>$1</h2>')
		.replace(/^# (.*$)/gm, '<h1>$1</h1>')
		.replace(/\n/g, '<br>')
}

/**
 * Convert an external document into an object shaped like a `content` table row,
 * for serving live (un-synced) external data. Not persisted — `id` is the
 * external id so the row stays navigable in the UI.
 */
export function externalDocToContentItem(
	doc: ExternalDocument,
	collection: {
		id: string
		projectId: string
		fields: CollectionField[]
	},
): Record<string, unknown> {
	const { markdown, metadata } = documentToMarkdown(doc, collection.fields)
	const slug = slugFromDoc(metadata)
	const createdAt = toDate(metadata.createdAt) || objectIdCreatedAt(doc._id)
	const updatedAt = toDate(metadata.updatedAt)
	const publishedAt = toDate(metadata.publishedAt)

	return {
		id: doc._id,
		externalId: doc._id,
		projectId: collection.projectId,
		collectionId: collection.id,
		slug,
		metadata,
		markdown,
		html: markdownToBasicHtml(markdown),
		status: normalizeStatus(metadata.status),
		locale: 'en',
		version: 1,
		createdBy: null,
		// Live rows are not persisted — leave timestamps null when the source has
		// none, so the UI shows "—" instead of a misleading fetch-time "just now".
		createdAt: createdAt || updatedAt || null,
		updatedAt: updatedAt || createdAt || null,
		publishedAt: publishedAt || null,
		live: true,
	}
}

function buildCachedContentValues(
	doc: ExternalDocument,
	collection: {
		id: string
		projectId: string
		fields: CollectionField[]
	},
	opts: Pick<SyncOptions, 'userId'>,
): { values: CachedContentValues; slug: string | null } {
	const { markdown, metadata } = documentToMarkdown(doc, collection.fields)
	const slug = slugFromDoc(metadata)

	// Simple HTML from markdown (basic conversion)
	const html = markdownToBasicHtml(markdown)

	const createdAt = toDate(metadata.createdAt) || objectIdCreatedAt(doc._id)
	const updatedAt = toDate(metadata.updatedAt)
	const publishedAt = toDate(metadata.publishedAt)

	return {
		slug,
		values: {
			projectId: collection.projectId,
			collectionId: collection.id,
			metadata,
			markdown,
			html,
			externalId: doc._id,
			status: normalizeStatus(metadata.status),
			locale: 'en',
			createdBy: opts.userId || null,
			...(createdAt ? { createdAt } : {}),
			// Prefer a real source/ObjectId date over the cache write time.
			updatedAt: updatedAt || createdAt || new Date(),
			...(publishedAt ? { publishedAt } : {}),
		},
	}
}

function diffCachedContent(
	existing: Record<string, unknown>,
	next: CachedContentValues,
): SyncChange[] {
	const changes: SyncChange[] = []
	pushChange(changes, 'status', existing.status, next.status)
	pushChange(changes, 'markdown', existing.markdown, next.markdown)

	const localMetadata = (existing.metadata || {}) as Record<string, unknown>
	const keys = new Set([...Object.keys(localMetadata), ...Object.keys(next.metadata)])
	for (const key of keys) {
		pushChange(changes, `metadata.${key}`, localMetadata[key], next.metadata[key])
	}
	return changes
}

function pushChange(changes: SyncChange[], field: string, local: unknown, external: unknown) {
	if (stableValue(local) !== stableValue(external)) changes.push({ field, local, external })
}

function stableValue(value: unknown): string {
	if (value instanceof Date) return value.toISOString()
	if (value && typeof value === 'object')
		return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort())
	return String(value ?? '')
}

function normalizeStatus(value: unknown): ContentStatus {
	if (typeof value === 'string' && VALID_STATUSES.has(value)) return value as ContentStatus
	return 'published'
}

function toDate(value: unknown): Date | undefined {
	if (!value) return undefined
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
	if (typeof value === 'string' || typeof value === 'number') {
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? undefined : date
	}
	return undefined
}

/**
 * Recover a creation date from a MongoDB ObjectId. The first 4 bytes of a 24-hex
 * ObjectId encode the creation time in seconds — used as a real timestamp fallback
 * for imported records that carry no explicit date field.
 */
function objectIdCreatedAt(id: string): Date | undefined {
	if (!/^[a-f0-9]{24}$/i.test(id)) return undefined
	const seconds = Number.parseInt(id.slice(0, 8), 16)
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined
	const date = new Date(seconds * 1000)
	return Number.isNaN(date.getTime()) ? undefined : date
}
