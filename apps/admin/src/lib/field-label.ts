/**
 * Human-readable labels for schema field names.
 *
 * Imported collections rarely carry a `label` for their columns, so the editor
 * used to print the raw identifier — `postImage`, `createdAt`, `meta_description`.
 * These turn that into headline-style prose: `Post Image`, `Created at`,
 * `Meta Description`.
 */

/** Tokens that read wrong in title case and stay fully uppercase. */
const ACRONYMS = new Set([
	'api',
	'cdn',
	'css',
	'cta',
	'dns',
	'faq',
	'html',
	'id',
	'ip',
	'json',
	'jpg',
	'og',
	'pdf',
	'png',
	'rss',
	'seo',
	'sku',
	'svg',
	'ui',
	'url',
	'uri',
	'ux',
	'utm',
	'xml',
])

/**
 * Standard title-case small words: lowercased unless they lead the label. This
 * is what keeps `createdAt` reading as "Created at" rather than the stilted
 * "Created At", while `postImage` still reads "Post Image".
 */
const MINOR_WORDS = new Set([
	'a',
	'an',
	'and',
	'as',
	'at',
	'but',
	'by',
	'for',
	'from',
	'in',
	'into',
	'nor',
	'of',
	'off',
	'on',
	'onto',
	'or',
	'over',
	'per',
	'the',
	'to',
	'up',
	'via',
	'vs',
	'with',
])

/**
 * `postImage` → `Post Image`, `created_at` → `Created at`, `imageUrl` → `Image URL`.
 *
 * A value that already contains whitespace was written by a human (a schema
 * `label`), so it is returned untouched — re-casing someone's "Author bio" into
 * "Author Bio" would be a regression, not a fix.
 */
export function humanizeFieldName(raw: string): string {
	const name = raw.trim()
	if (!name) return ''
	if (/\s/.test(name)) return name
	const words = name
		// `postImage` → `post Image`; `SEOTitle` → `SEO Title`.
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/[_\-.]+/g, ' ')
		.trim()
		.split(/\s+/)
	return words
		.map((word, i) => {
			const lower = word.toLowerCase()
			if (ACRONYMS.has(lower)) return lower.toUpperCase()
			if (i > 0 && MINOR_WORDS.has(lower)) return lower
			return lower.charAt(0).toUpperCase() + lower.slice(1)
		})
		.join(' ')
}

/** Label for a schema field: its explicit `label` when set, else a humanized name. */
export function fieldLabel(field: { name: string; label?: string }): string {
	return humanizeFieldName(field.label?.trim() || field.name)
}
