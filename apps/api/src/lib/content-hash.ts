import { createHash } from 'node:crypto'

// Explicit authoring state: exclude derived HTML, relation/media expansion,
// analytics and external-sync bookkeeping. Include identity and revision to
// prevent replay across records and after an edit followed by a revert.
const HASH_FIELDS = [
	'id',
	'projectId',
	'collectionId',
	'slug',
	'status',
	'metadata',
	'markdown',
	'locale',
	'version',
	'createdAt',
	'updatedAt',
	'publishedAt',
	'externalId',
] as const

function canonical(value: unknown): string {
	if (value instanceof Date) return JSON.stringify(value.toISOString())
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

export function contentHash(record: Record<string, unknown>): string {
	const state = Object.fromEntries(HASH_FIELDS.map((key) => [key, record[key] ?? null]))
	return `sha256:${createHash('sha256').update('innolope-content-v1\n').update(canonical(state)).digest('hex')}`
}

export function withContentHash<T extends Record<string, unknown>>(
	record: T,
): T & { contentHash: string } {
	return { ...record, contentHash: contentHash(record) }
}
