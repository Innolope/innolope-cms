interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
}
import type { ExternalDbAdapter, ExternalDocument } from '../adapters/external-db.js'

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

	const markdown = frontmatter
		? `---\n${frontmatter}\n---\n\n${bodyContent}`
		: bodyContent

	return { markdown, metadata }
}

/** Find the most likely "body" field in a document */
function findBodyField(doc: ExternalDocument, _fields: CollectionField[]): string | null {
	const bodyNames = ['content', 'body', 'description', 'text', 'markdown', 'html']
	for (const name of bodyNames) {
		if (doc[name] && typeof doc[name] === 'string' && (doc[name] as string).length > 100) return name
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
	if (Array.isArray(value)) return `[${value.map(v => formatYamlValue(v)).join(', ')}]`
	return JSON.stringify(value)
}

/** Generate a slug from document metadata or ID */
export function generateSlugFromDoc(metadata: Record<string, unknown>, externalId: string): string {
	const title = (metadata.title || metadata.name || metadata.slug) as string | undefined
	if (title) {
		return title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 80) || externalId
	}
	return externalId.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

/** Populate markdown cache for all documents in an external collection */
export async function populateMarkdownCache(
	db: { insert: Function; select: Function },
	contentTable: unknown,
	adapter: ExternalDbAdapter,
	collection: {
		id: string
		projectId: string
		externalTable: string
		fields: CollectionField[]
	},
	opts: { batchSize?: number; userId?: string } = {},
): Promise<number> {
	const batchSize = opts.batchSize || 100
	let offset = 0
	let totalCached = 0

	while (true) {
		const docs = await adapter.findAll(collection.externalTable, { limit: batchSize, offset })
		if (docs.length === 0) break

		for (const doc of docs) {
			const { markdown, metadata } = documentToMarkdown(doc, collection.fields)
			const slug = generateSlugFromDoc(metadata, doc._id)

			// Simple HTML from markdown (basic conversion)
			const html = markdown
				.replace(/^### (.*$)/gm, '<h3>$1</h3>')
				.replace(/^## (.*$)/gm, '<h2>$1</h2>')
				.replace(/^# (.*$)/gm, '<h1>$1</h1>')
				.replace(/\n/g, '<br>')

			try {
				await (db.insert as Function)(contentTable).values({
					projectId: collection.projectId,
					collectionId: collection.id,
					slug: `${slug}-${doc._id.slice(-6)}`,
					metadata,
					markdown,
					html,
					externalId: doc._id,
					status: 'published',
					locale: 'en',
					createdBy: opts.userId || null,
				})
				totalCached++
			} catch {
				// Skip duplicates (unique constraint on slug+locale+projectId)
			}
		}

		offset += batchSize
	}

	return totalCached
}
