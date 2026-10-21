/**
 * Schema fields that duplicate something the content row already owns.
 *
 * An imported collection's detected schema routinely contains `createdAt`,
 * `updatedAt`, `publishedAt`, `status` and `slug` — the same concepts the CMS
 * keeps as columns on the `content` row. The sync copies the source values onto
 * those columns (see `markdown-cache.ts`), so the two are the same value shown
 * twice: the list offered both "Created" and `createdAt`, and the editor rendered
 * a second date input beside the built-in control.
 *
 * The built-in wins everywhere. It is localized, formats as relative time with an
 * absolute-date tooltip, and is what filters and sorting already key on. The
 * schema-field twin is hidden rather than deleted: it still exists in
 * `collections.fields`, which is what lets the value reach the source database on
 * write.
 */
export const SYSTEM_COLUMN_TWINS = new Set([
	'createdAt',
	'updatedAt',
	'publishedAt',
	'status',
	'slug',
])

/** True when a schema field merely restates a system column of the content row. */
export function isSystemColumnTwin(name: string): boolean {
	return SYSTEM_COLUMN_TWINS.has(name)
}

/**
 * Database-owned counters and tags. Narrow on purpose: `version` or `revision`
 * can be real content (a changelog's release number), so only the spellings
 * that are unambiguously machinery are listed.
 */
const VERSION_COUNTER_NAMES = new Set(['__v', '_v', '_rev', '_version', '_etag', 'etag'])

/** Twins worth showing read-only. `slug` already has its own input. */
const TECHNICAL_TWINS = new Set(['createdAt', 'updatedAt', 'publishedAt', 'status'])

/**
 * True when a field belongs in the collapsed "Technical fields" section instead
 * of the main form: placed there in the schema editor, a value the CMS cannot
 * model (`ui.opaque`), a version counter, or the source's copy of a lifecycle
 * column. An explicit `ui.section: 'main'` always wins.
 */
export function isTechnicalField(field: {
	name: string
	ui?: { section?: 'main' | 'technical'; opaque?: boolean; hidden?: boolean }
}): boolean {
	if (field.ui?.hidden) return false
	if (field.ui?.section === 'main') return false
	return (
		field.ui?.section === 'technical' ||
		field.ui?.opaque === true ||
		VERSION_COUNTER_NAMES.has(field.name) ||
		TECHNICAL_TWINS.has(field.name)
	)
}
