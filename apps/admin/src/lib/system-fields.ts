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
