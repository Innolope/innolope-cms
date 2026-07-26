/**
 * Localized field values — objects keyed by locale code (`{ en: "...", uk: "..." }`).
 *
 * Two different localization mechanisms coexist in this CMS and they are easy to
 * confuse:
 *
 *  1. Row-level `content.locale` — one CMS row per language, unique on
 *     (slug, locale, projectId). This is what the API's `locale` parameter sets.
 *  2. Field-level locale maps — ONE source document holding every translation
 *     (`{ title: { en, uk }, content: { en, uk } }`). This is the convention
 *     imported MongoDB projects use, and it's what the site actually reads.
 *
 * Collections whose fields carry `localized: true` use mechanism 2. Writing a
 * bare string to such a field would replace the whole map and drop every other
 * translation, so `applyLocalizedWrite` folds the incoming value into the map
 * under the row's locale instead. That is what connects the two mechanisms: a
 * caller that only knows about `locale` still writes the correct language slot.
 *
 * The shape helpers mirror `apps/admin/src/lib/locale-value.ts`; the admin
 * detects locale maps at runtime because imported schemas historically had no
 * `localized` flag at all.
 */

import type { CollectionField } from '@innolope/config'

/**
 * Common ISO 639-1 codes, used to recognize locale-shaped data before project
 * settings list the locale. Includes widely-used non-standard codes (`ua`, `cn`,
 * `kr`) alongside the proper ISO equivalents — real imported data uses them.
 */
export const KNOWN_LOCALE_CODES = new Set([
	'en',
	'es',
	'fr',
	'de',
	'it',
	'pt',
	'nl',
	'sv',
	'no',
	'da',
	'fi',
	'pl',
	'cs',
	'sk',
	'ro',
	'hu',
	'tr',
	'el',
	'bg',
	'hr',
	'sl',
	'sr',
	'lt',
	'lv',
	'et',
	'ru',
	'ua',
	'uk',
	'be',
	'zh',
	'cn',
	'ja',
	'ko',
	'kr',
	'vi',
	'th',
	'id',
	'ms',
	'tl',
	'hi',
	'bn',
	'ar',
	'he',
	'fa',
	'ur',
])

/** Strict locale-code shape check: 2-3 lowercase letters, optional `-XX` region. */
export function looksLikeLocaleCode(key: string): boolean {
	return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(key)
}

/**
 * Heuristic: the value looks like a `{ locale: text }` map.
 *
 * True iff the value is a plain non-empty object AND every value is a string (or
 * null/undefined) AND every key is either a configured project locale or a
 * recognized code. The strings-only rule is what keeps structured objects like
 * `{ platform: "linkedin", url: "..." }` from being mistaken for translations.
 */
export function isLocaleMap(
	value: unknown,
	locales: string[] = [],
): value is Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) return false
	if (!entries.every(([, v]) => v === null || v === undefined || typeof v === 'string')) {
		return false
	}
	const locSet = new Set(locales)
	return entries.every(
		([k]) => locSet.has(k) || (KNOWN_LOCALE_CODES.has(k.toLowerCase()) && looksLikeLocaleCode(k)),
	)
}

/**
 * Loose companion to `isLocaleMap`: a plain non-empty object whose every key is
 * a locale code (configured or recognized), with NO constraint on the values.
 * Catches locale-keyed structures that aren't `{ locale: text }` maps — per-
 * language arrays like `{ en: [...], uk: [...] }` (legitimate, e.g. localized
 * tags) and record wrappers like `{ en: { title... } }` (an anti-pattern the
 * validator rejects).
 */
export function isLocaleKeyedObject(
	value: unknown,
	locales: string[] = [],
): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const keys = Object.keys(value)
	if (keys.length === 0) return false
	const locSet = new Set(locales)
	return keys.every(
		(k) => locSet.has(k) || (KNOWN_LOCALE_CODES.has(k.toLowerCase()) && looksLikeLocaleCode(k)),
	)
}

/**
 * Field names treated as the record's body, in precedence order. Shared with
 * `buildExternalData` so the field it writes the markdown into is exactly the
 * field this module checks for a `localized` flag.
 */
export const BODY_FIELD_NAMES = ['content', 'body', 'markdown', 'text', 'html'] as const

/** The collection's body field when it's declared localized, else null. */
export function findLocalizedBodyField(fields: CollectionField[]): string | null {
	for (const name of BODY_FIELD_NAMES) {
		const field = fields.find((f) => f.name === name)
		if (field?.localized) return field.name
		// The first matching body field wins whether or not it's localized —
		// mirrors buildExternalData, which stops at the same one.
		if (field) return null
	}
	return null
}

/**
 * Fold one write into a locale map without losing the other translations.
 *
 *  - a bare string — or a bare array, for localized array fields like tags —
 *    targets a single language: the row's `locale` slot,
 *  - an explicit map is applied per-locale (so a partial `{ uk: ... }` write
 *    updates Ukrainian and leaves English alone),
 *  - a `null`/`undefined` slot in an explicit map DELETES that translation
 *    (mirrors the metadata-level "null deletes the key" update rule); if that
 *    empties the map, the whole field folds to null so the metadata merge
 *    removes it instead of storing an empty `{}`,
 *  - anything else passes through untouched for the validator to judge.
 */
function foldIntoLocaleMap(existing: unknown, incoming: unknown, locale: string): unknown {
	const base: Record<string, unknown> = isLocaleKeyedObject(existing) ? { ...existing } : {}
	if (typeof incoming === 'string' || Array.isArray(incoming)) return { ...base, [locale]: incoming }
	if (isLocaleKeyedObject(incoming)) {
		const merged: Record<string, unknown> = { ...base }
		for (const [key, value] of Object.entries(incoming)) {
			if (value === null || value === undefined) delete merged[key]
			else merged[key] = value
		}
		return Object.keys(merged).length > 0 ? merged : null
	}
	return incoming
}

/**
 * Normalize a write against a collection's localized fields.
 *
 * Returns the metadata to persist. Only fields declared `localized: true` are
 * touched, and only when the write actually carries them — a collection with no
 * localized fields gets its metadata back by reference.
 *
 * When the body field is localized, a `markdown` body is folded into the same
 * map under the row's locale, unless the caller already supplied that field in
 * metadata explicitly (an explicit map always wins). Without this the flattened
 * markdown would reach `buildExternalData` and overwrite the source document's
 * whole `content` map with a single-language string.
 */
export function applyLocalizedWrite(
	fields: CollectionField[],
	input: { metadata?: Record<string, unknown>; markdown?: string },
	opts: { locale: string; existing?: Record<string, unknown> },
): Record<string, unknown> | undefined {
	const localizedNames = fields.filter((f) => f.localized).map((f) => f.name)
	if (localizedNames.length === 0) return input.metadata

	const metadata = input.metadata
	let out: Record<string, unknown> | null = null
	const target = () => {
		out ??= { ...(metadata ?? {}) }
		return out
	}

	for (const name of localizedNames) {
		if (!metadata || !(name in metadata)) continue
		const folded = foldIntoLocaleMap(opts.existing?.[name], metadata[name], opts.locale)
		if (folded !== metadata[name]) target()[name] = folded
	}

	const bodyField = findLocalizedBodyField(fields)
	if (bodyField && !(metadata && bodyField in metadata) && input.markdown) {
		target()[bodyField] = foldIntoLocaleMap(opts.existing?.[bodyField], input.markdown, opts.locale)
	}

	return out ?? metadata
}
