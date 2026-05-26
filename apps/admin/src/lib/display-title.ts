/**
 * Single source of truth for "what string should we show as this record's label?"
 *
 * Used by:
 *   - the collection list view (`routes/collections.$slug.tsx`)
 *   - the relation/reference picker (`components/editor/relation-field.tsx`)
 *
 * Before this util, those two surfaces had independent logic that disagreed:
 *   - the list only checked literal `metadata.title` / `metadata.name`
 *   - the picker used a regex heuristic over field names
 * Neither knew about per-collection overrides, neither fell back to the slug.
 * Result: records whose title-bearing field is `courseName` (or any custom name)
 * showed up as raw UUIDs in the list. This resolver fixes both surfaces and lets
 * the schema editor pin a specific field per collection.
 */

import { resolveLocalizedValue } from './locale-value'

interface MinimalField {
	name: string
	type: string
}

interface MinimalRecord {
	id: string
	slug?: string | null
	metadata?: Record<string, unknown> | null
}

interface MinimalCollection {
	fields?: MinimalField[]
	titleField?: string | null
}

export interface ResolveDisplayTitleCtx {
	defaultLocale?: string
}

/** Regex used by the smart heuristic — matches name-bearing field names. */
const LABEL_NAME_PATTERN = /(^|[_ -])(title|name|label|heading)([_ ]|$)/i

/**
 * Pick which schema field most likely holds a human label for this collection.
 * Priority: configured `titleField` → exact `title` → exact `name` →
 *           regex-name match → first localized text/string field → first text/string field.
 */
export function pickTitleField(collection: MinimalCollection): string | null {
	if (collection.titleField) return collection.titleField
	const fields = collection.fields ?? []
	if (fields.length === 0) return null

	const byName = (n: string) => fields.find((f) => f.name === n)
	if (byName('title')) return 'title'
	if (byName('name')) return 'name'

	const regexHit = fields.find((f) => LABEL_NAME_PATTERN.test(f.name))
	if (regexHit) return regexHit.name

	// localized text is more likely a title than plain text
	const localizedText = fields.find(
		(f) =>
			(f.type === 'text' || f.type === 'string' || f.type === 'object') &&
			(f as MinimalField & { localized?: boolean }).localized,
	)
	if (localizedText) return localizedText.name

	const anyText = fields.find((f) => f.type === 'text' || f.type === 'string')
	return anyText?.name ?? null
}

/**
 * Resolve a record to its display label.
 *
 * Fallback chain:
 *   1. value at `metadata[titleField]` resolved through `resolveLocalizedValue`
 *   2. record's `slug` (short, human-shaped — better than a UUID)
 *   3. record's `id` (last resort — always present)
 */
export function resolveDisplayTitle(
	record: MinimalRecord,
	collection: MinimalCollection,
	ctx: ResolveDisplayTitleCtx = {},
): string {
	const field = pickTitleField(collection)
	if (field) {
		const value = record.metadata?.[field]
		const resolved = resolveLocalizedValue(value, ctx)
		if (resolved) return resolved
	}
	const slug = (record.slug ?? '').trim()
	if (slug) return slug
	return record.id
}
