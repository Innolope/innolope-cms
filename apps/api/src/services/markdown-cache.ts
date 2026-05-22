interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
}

import type { content, contentVersions, Database } from '@innolope/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { ExternalDbAdapter, ExternalDocument } from '../adapters/external-db.js'

/** Postgres `unique_violation` — the row already exists under a colliding slug. */
function isUniqueViolation(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

const VALID_STATUSES = new Set(['draft', 'pending_review', 'published', 'archived'])
type ContentStatus = 'draft' | 'pending_review' | 'published' | 'archived'
type ContentTable = typeof content
type SyncOptions = { batchSize?: number; userId?: string; versionTable?: typeof contentVersions }
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
	slug: string
	changeType: 'created' | 'updated'
	changes: SyncChange[]
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
			bodyContent = String(value ?? '')
		} else {
			metadata[key] = value
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

/** Generate a slug from document metadata or ID */
export function generateSlugFromDoc(metadata: Record<string, unknown>, externalId: string): string {
	const raw = metadata.title ?? metadata.name ?? metadata.slug
	const title = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : undefined
	if (title) {
		return (
			title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 80) || externalId
		)
	}
	return externalId.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
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

/** Refresh cached CMS rows from an external collection. External documents are the source of truth. */
export async function syncMarkdownCache(
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
): Promise<{ created: number; updated: number }> {
	const batchSize = opts.batchSize || 100
	let offset = 0
	let created = 0
	let updated = 0

	while (true) {
		const docs = await adapter.findAll(collection.externalTable, { limit: batchSize, offset })
		if (docs.length === 0) break

		for (const doc of docs) {
			const { values, slug } = buildCachedContentValues(doc, collection, opts)

			try {
				const [existing] = await db
					.select()
					.from(contentTable)
					.where(
						and(
							eq(contentTable.projectId, collection.projectId),
							eq(contentTable.collectionId, collection.id),
							eq(contentTable.externalId, doc._id),
						),
					)
					.limit(1)

				if (existing) {
					if (opts.versionTable) {
						await db.insert(opts.versionTable).values({
							contentId: existing.id,
							version: existing.version,
							markdown: existing.markdown,
							metadata: existing.metadata,
							createdBy: opts.userId || null,
						})
					}
					await db
						.update(contentTable)
						.set({ ...values, version: (existing.version || 1) + 1 })
						.where(eq(contentTable.id, existing.id))
					updated++
				} else {
					await db.insert(contentTable).values({
						...values,
						slug: `${slug}-${doc._id.slice(-6)}`,
					})
					created++
				}
			} catch (err) {
				// A duplicate slug is expected and harmless; any other failure must surface
				// so a sync that cached nothing is not silently reported as a success.
				if (!isUniqueViolation(err)) throw err
			}
		}

		offset += batchSize
	}

	return { created, updated }
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
			return { ...values, slug: `${slug}-${doc._id.slice(-6)}` }
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
	collection: {
		id: string
		projectId: string
		externalTable: string
		fields: CollectionField[]
	},
	opts: { batchSize?: number; limit?: number } = {},
): Promise<{ discrepancies: SyncPreviewItem[]; total: number }> {
	const batchSize = opts.batchSize || 100
	const limit = opts.limit || 25
	let offset = 0
	let total = 0
	const discrepancies: SyncPreviewItem[] = []

	while (true) {
		const docs = await adapter.findAll(collection.externalTable, { limit: batchSize, offset })
		if (docs.length === 0) break

		for (const doc of docs) {
			const { values, slug } = buildCachedContentValues(doc, collection, {})
			const [existing] = await db
				.select()
				.from(contentTable)
				.where(
					and(
						eq(contentTable.projectId, collection.projectId),
						eq(contentTable.collectionId, collection.id),
						eq(contentTable.externalId, doc._id),
					),
				)
				.limit(1)

			if (!existing) {
				total++
				if (discrepancies.length < limit) {
					discrepancies.push({
						externalId: doc._id,
						slug: `${slug}-${doc._id.slice(-6)}`,
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
	const slug = `${generateSlugFromDoc(metadata, doc._id)}-${doc._id.slice(-6)}`
	const createdAt = toDate(metadata.createdAt)
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
		createdAt: createdAt || updatedAt || new Date(),
		updatedAt: updatedAt || new Date(),
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
): { values: CachedContentValues; slug: string } {
	const { markdown, metadata } = documentToMarkdown(doc, collection.fields)
	const slug = generateSlugFromDoc(metadata, doc._id)

	// Simple HTML from markdown (basic conversion)
	const html = markdownToBasicHtml(markdown)

	const createdAt = toDate(metadata.createdAt)
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
			updatedAt: updatedAt || new Date(),
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
