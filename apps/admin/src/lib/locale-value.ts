/**
 * Helpers for working with localized field values — objects keyed by locale code
 * (`{ en: "...", uk: "..." }`). External/imported collections frequently store such
 * maps without the schema carrying a `localized: true` flag, so detection is
 * heuristic.
 */

/**
 * Common ISO 639-1 codes used to recognize locale-shaped data even when project
 * settings haven't been updated yet (imported content often uses `ua`/`uk` for
 * Ukrainian without anyone configuring it). Includes a few widely-used non-standard
 * codes (`ua`, `cn`, `kr`) alongside the proper ISO equivalents.
 */
const KNOWN_LOCALE_CODES = new Set([
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
function looksLikeLocaleCode(key: string): boolean {
	return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(key)
}

/**
 * Heuristic: value looks like a `{ locale: text }` map.
 *
 * Returns true iff value is a plain non-empty object AND every value is a string
 * (or null/undefined) AND every key is either a configured project locale or a
 * recognized ISO 639-1 code. The strings-only requirement avoids false positives on
 * structured objects like `{ platform: "linkedin", url: "..." }`.
 */
export function isLocaleMap(value: unknown, locales: string[]): boolean {
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
 * Resolve a possibly-localized value to a display string.
 *
 *  - plain string: returned trimmed
 *  - locale map `{ en, uk, ... }`: project `defaultLocale` → `en` → first non-empty
 *  - anything else: null
 */
export function resolveLocalizedValue(
	value: unknown,
	opts: { defaultLocale?: string } = {},
): string | null {
	if (value == null) return null
	if (typeof value === 'string') return value.trim() || null
	if (typeof value === 'object' && !Array.isArray(value)) {
		const map = value as Record<string, unknown>
		const pick = (key: string): string | null => {
			const v = map[key]
			return typeof v === 'string' && v.trim() ? v.trim() : null
		}
		if (opts.defaultLocale) {
			const preferred = pick(opts.defaultLocale)
			if (preferred) return preferred
		}
		const english = pick('en')
		if (english) return english
		for (const key of Object.keys(map)) {
			const candidate = pick(key)
			if (candidate) return candidate
		}
	}
	return null
}
