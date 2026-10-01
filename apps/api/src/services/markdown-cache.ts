interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
}

import { createHash } from 'node:crypto'
import { CONTENT_STATUSES } from '@innolope/config'
import type { collections, content, contentVersions, Database } from '@innolope/db'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { ExternalDbAdapter, ExternalDocument } from '../adapters/external-db.js'
import { BODY_FIELD_NAMES } from './localized-fields.js'
import { mergeSyncState, type SyncState, stableValue, syncState } from './sync-state.js'

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

// Derived from the shared list so a new status can't be accepted by the API and
// silently coerced to `published` when the same value is read back from a source DB.
const VALID_STATUSES = new Set<string>(CONTENT_STATUSES)
type ContentStatus = (typeof CONTENT_STATUSES)[number]
type ContentTable = typeof content
type SyncOptions = {
	batchSize?: number
	userId?: string
	versionTable?: typeof contentVersions
	/** Required to persist the sync watermark + auto-detected cursor column. */
	collectionsTable?: typeof collections
	resolutions?: Record<string, { token: string; choice: 'local' | 'external' }>
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
	externalSnapshot: SyncState
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

export interface SyncConflict {
	contentId: string
	externalId: string
	slug: string | null
	metadata: Record<string, unknown>
	token: string
	local?: SyncState
	external?: SyncState
	categories: Array<'content' | 'details' | 'status'>
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
		return (value.includes('\u0000') ? value.split('\u0000').join('') : value) as T
	}
	if (Array.isArray(value)) return value.map(stripNullBytes) as T
	if (value !== null && typeof value === 'object' && value.constructor === Object) {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value)) out[k] = stripNullBytes(v)
		return out as T
	}
	return value
}

/**
 * Locale-code shape check, matching the admin's `isLocaleMap` heuristic:
 * 2-3 lowercase letters with an optional `-XX` region.
 */
function looksLikeLocaleCode(key: string): boolean {
	return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(key)
}

/**
 * True when a value is a `{ en: "...", ua: "..." }` locale map — the shape a
 * localized long-form field takes in the source document.
 */
function isLocaleMap(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) return false
	return entries.every(
		([k, v]) => looksLikeLocaleCode(k) && (v === null || v === undefined || typeof v === 'string'),
	)
}

/**
 * Flatten a locale-mapped body to a single string for the `markdown` column,
 * which backs list previews, search and the HTML cache. Picks the longest
 * non-empty translation — without the project's default locale in scope this is
 * the most useful deterministic choice, and the full map still reaches the
 * editor via `metadata` so no locale is lost.
 */
function flattenLocaleMap(map: Record<string, string>): string {
	let best = ''
	for (const value of Object.values(map)) {
		if (typeof value === 'string' && value.length > best.length) best = value
	}
	return best
}

/**
 * Convert an external document to a body-only markdown string plus metadata.
 * Metadata is the single source of truth for structured fields — the markdown
 * deliberately carries NO YAML frontmatter copy (it used to, which meant every
 * field existed in two places that could disagree; see services/frontmatter.ts).
 */
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
			// A localized body stays in `metadata` as the full locale map (that's what
			// the editor edits and what gets written back); `markdown` only carries a
			// flattened copy so previews and search keep working.
			if (isLocaleMap(value)) {
				metadata[key] = stripNullBytes(value)
				bodyContent = stripNullBytes(flattenLocaleMap(value))
			} else {
				bodyContent = stripNullBytes(String(value ?? ''))
			}
		} else {
			metadata[key] = stripNullBytes(value)
		}
	}

	return { markdown: bodyContent, metadata }
}

/**
 * Find the field holding the record's body.
 *
 * The candidate names and their order are shared with `buildExternalData`, which
 * writes the markdown back into the first one the collection maps. If the two
 * disagreed the body would be lifted out of `metadata` on read and then dropped
 * on write, so they must stay in step.
 *
 * The collection schema is authoritative: a declared body field is the body even
 * when the sampled document has it empty or missing. That is what stops an empty
 * source body from being cached as `metadata.content = ""` — a value which then
 * outranks `markdown` in `buildExternalData` and silently discards whatever the
 * editor typed.
 *
 * There is deliberately NO minimum length on the canonical names. A short body
 * is still a body; the old 100-character floor pushed it into `metadata`, where
 * the editor hides `content`/`body`, and the article rendered blank.
 */
function findBodyField(doc: ExternalDocument, fields: CollectionField[]): string | null {
	for (const name of BODY_FIELD_NAMES) {
		if ((fields ?? []).some((field) => field.name === name)) return name
	}
	// No usable schema — a MongoDB collection introspected while empty has no
	// fields at all. Fall back to the document's own keys, same names, same order.
	for (const name of BODY_FIELD_NAMES) {
		const value = doc[name]
		// A localized body (`content: { en, ua }`) is still the body — without this it
		// fell through to `metadata` as an anonymous object and the editor, which hides
		// `content`/`body`, never rendered it at all.
		if (typeof value === 'string' || isLocaleMap(value)) return name
	}
	// Last resort: a body living under a name we cannot write back to. These keep
	// the 100-character floor — a short `description` is a structured field, not a
	// body, and lifting it out of metadata on a hunch would cost more than it
	// gains when the write path can't return it to the source document.
	if (isLocaleMap(doc.description) && flattenLocaleMap(doc.description).length > 0) {
		return 'description'
	}
	if (typeof doc.description === 'string' && doc.description.length > 100) return 'description'
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
	conflicts: SyncConflict[]
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
	const conflicts: SyncConflict[] = []
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
		conflicts.push(...result.conflicts)

		offset += batchSize
		if (docs.length < batchSize) break
	}

	if (opts.collectionsTable && conflicts.length === 0) {
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

	return { created, updated, mode, cursorColumn, newCursor, conflicts }
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
): Promise<{ created: number; updated: number; conflicts: SyncConflict[] }> {
	if (docs.length === 0) return { created: 0, updated: 0, conflicts: [] }

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
		const existing = existingByExternalId.get(doc._id)
		const { values, slug } = buildCachedContentValues(doc, collection, opts, existing)
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

	const conflicts: SyncConflict[] = []
	let updatedCount = 0
	// Lock each row and compare again: an edit made during the external scan must
	// not be overwritten, nor may an old dialog approve a newer external version.
	await runInChunks(toUpdate, 10, async ({ existing, next }) => {
		await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(contentTable)
				.where(eq(contentTable.id, existing.id))
				.for('update')
			if (!current) return
			const incoming = syncState(next)
			const local = syncState(current)
			const token = createHash('sha256')
				.update(
					stableValue({
						local,
						incoming,
						baseline: current.externalSnapshot,
						version: current.version,
					}),
				)
				.digest('hex')
			const resolution = opts.resolutions?.[current.id]
			const choice = resolution?.token === token ? resolution.choice : undefined
			const merged = mergeSyncState(current.externalSnapshot, local, incoming, choice)
			// For legacy authored rows, history tells us which fields the CMS
			// edited. Incoming changes to other fields still sync without a prompt.
			if (
				!current.externalSnapshot &&
				current.updatedSource &&
				!['import', 'system'].includes(current.updatedSource)
			) {
				const [previous] = opts.versionTable
					? await tx
							.select()
							.from(opts.versionTable)
							.where(eq(opts.versionTable.contentId, current.id))
							.orderBy(desc(opts.versionTable.version))
							.limit(1)
					: []
				const baseline = previous ? { ...syncState(previous), status: local.status } : null
				if (baseline) {
					const legacyMerge = mergeSyncState(baseline, local, incoming, choice)
					merged.conflicts = legacyMerge.conflicts
					merged.state = legacyMerge.state
				} else {
					merged.conflicts = diffCachedContent(current, next).map((change) => change.field)
					if (choice === 'local') merged.state = local
				}
			}

			if (merged.conflicts.length && !choice) {
				conflicts.push({
					contentId: current.id,
					externalId: next.externalId,
					slug: current.slug,
					metadata: current.metadata,
					local: { ...local, markdown: local.markdown.slice(0, 240) },
					external: { ...incoming, markdown: incoming.markdown.slice(0, 240) },
					token,
					categories: [
						...new Set(
							merged.conflicts.map((field) =>
								field === 'status' || field === 'metadata.status'
									? ('status' as const)
									: field === 'markdown'
										? ('content' as const)
										: ('details' as const),
							),
						),
					],
				})
				return
			}
			const changed = stableValue(local) !== stableValue(merged.state)
			if (changed && opts.versionTable) {
				await tx.insert(opts.versionTable).values({
					contentId: current.id,
					version: current.version,
					markdown: current.markdown,
					metadata: current.metadata,
					createdBy: opts.userId || null,
					source: 'system',
				})
			}
			const { locale: _locale, createdBy: _createdBy, ...sourceValues } = next
			await tx
				.update(contentTable)
				.set({
					...sourceValues,
					...merged.state,
					status: merged.state.status as ContentStatus,
					html: markdownToBasicHtml(merged.state.markdown),
					externalSnapshot: incoming,
					version: current.version + (changed ? 1 : 0),
				})
				.where(eq(contentTable.id, current.id))
			if (changed) updatedCount++
		})
	})

	// Even an unchanged legacy cache needs its first shared-state snapshot.
	const unchanged = existingRows.filter(
		(row) =>
			!toUpdate.some((item) => item.existing.id === row.id) &&
			stableValue(row.externalSnapshot) !== stableValue(syncState(row)),
	)
	for (const row of unchanged) {
		await db
			.update(contentTable)
			.set({ externalSnapshot: syncState(row) })
			.where(and(eq(contentTable.id, row.id), eq(contentTable.version, row.version)))
	}
	return { created: createdCount, updated: updatedCount, conflicts }
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
			// Same `existing` the sync itself will see, so the preview can't promise a
			// status change the apply won't make.
			const existing = existingByExternalId.get(doc._id)
			const { values, slug } = buildCachedContentValues(doc, collection, {}, existing)

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
		// Live rows are not persisted and have no CMS row to preserve a status from.
		status: resolveCachedStatus(metadata.status),
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
	/**
	 * The cached row this document will update, when there is one. A source
	 * document with no usable status keeps whatever the CMS already decided —
	 * only a row the CMS has never seen defaults to `published` (a legacy article
	 * being imported for the first time is already live on the site).
	 */
	existing?: { status?: string | null },
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
			externalSnapshot: {
				metadata,
				markdown,
				status: resolveCachedStatus(metadata.status, existing?.status),
			},
			status: resolveCachedStatus(metadata.status, existing?.status),
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

/**
 * Map a source value onto a CMS status, or `undefined` when the source carries
 * none we recognise.
 *
 * Absence is not a statement that the record is published. Collections whose
 * source table has no `status` column used to coerce to `published` on every
 * sync, which resurrected every local draft and every scheduled row the moment
 * anyone re-synced. An unrecognised non-empty value (`"active"`) is treated the
 * same way: it isn't a status we model, and guessing `published` is exactly the
 * failure being fixed.
 */
function readExternalStatus(value: unknown): ContentStatus | undefined {
	if (typeof value === 'string' && VALID_STATUSES.has(value)) return value as ContentStatus
	return undefined
}

/**
 * The status a synced row should end up with.
 *
 * The source wins when it says something we understand. Otherwise the CMS keeps
 * its own decision — a draft stays a draft, a scheduled row stays queued. Only a
 * row the CMS has never seen falls through to `published`, which is right: a
 * legacy article being imported for the first time is already live on the site.
 */
export function resolveCachedStatus(
	sourceStatus: unknown,
	existingStatus?: string | null,
): ContentStatus {
	return readExternalStatus(sourceStatus) ?? readExternalStatus(existingStatus) ?? 'published'
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
