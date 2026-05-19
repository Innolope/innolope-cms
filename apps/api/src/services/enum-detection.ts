import type { CollectionField } from '@innolope/config'
import type { content, Database } from '@innolope/db'
import { eq, type SQL, sql } from 'drizzle-orm'

type ContentTable = typeof content

/** Distinct-value count must be below this for a field to become an enum. */
const MAX_DISTINCT = 10
/** A single repeated value isn't a meaningful dropdown. */
const MIN_DISTINCT = 2
/** Below this row count, every text field looks low-cardinality — don't guess. */
const MIN_ROWS = 10
/** Values longer than this are prose (titles, descriptions), not enum members. */
const MAX_VALUE_LENGTH = 64

/**
 * Inspect an imported collection's cached content and upgrade low-cardinality
 * `text` fields to `enum`, seeding `options` from the distinct values found.
 * Returns a new fields array when something changed, or the original otherwise.
 */
export async function detectEnumFields(
	db: Database,
	contentTable: ContentTable,
	collectionId: string,
	fields: CollectionField[],
): Promise<CollectionField[]> {
	const textFields = fields.filter((f) => f.type === 'text')
	if (textFields.length === 0) return fields

	const selection: Record<string, SQL<string | null>> = {}
	for (const f of textFields) {
		selection[f.name] = sql<string | null>`${contentTable.metadata} ->> ${f.name}`
	}

	const rows = (await db
		.select(selection)
		.from(contentTable)
		.where(eq(contentTable.collectionId, collectionId))) as Record<string, string | null>[]

	const totalRows = rows.length
	if (totalRows < MIN_ROWS) return fields

	const distinct = new Map<string, Set<string>>(textFields.map((f) => [f.name, new Set<string>()]))
	const disqualified = new Set<string>()

	for (const row of rows) {
		for (const f of textFields) {
			if (disqualified.has(f.name)) continue
			const raw = row[f.name]
			if (raw == null || raw === '') continue
			if (raw.length > MAX_VALUE_LENGTH) {
				disqualified.add(f.name)
				continue
			}
			distinct.get(f.name)?.add(raw)
		}
	}

	let changed = false
	const next = fields.map((f): CollectionField => {
		if (f.type !== 'text' || disqualified.has(f.name)) return f
		const values = distinct.get(f.name)
		if (!values) return f
		const count = values.size
		// Few-but-repeated values across enough rows — treat as an enumeration.
		if (count < MIN_DISTINCT || count >= MAX_DISTINCT || count >= totalRows) return f
		changed = true
		return { ...f, type: 'enum', options: [...values].sort() }
	})

	return changed ? next : fields
}
