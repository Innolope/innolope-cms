import { isLocaleMap } from './locale-value'

/**
 * One-line summaries for collapsed repeater rows and nested cards.
 *
 * An editor scanning a list of social links wants "LinkedIn · linkedin.com/in/…",
 * not "#1". The summary prefers the field's configured `summaryKey`, then a key
 * that conventionally names the thing, and adds a link when the row has one.
 */

/** Keys that name a row, in the order they are tried. */
const NAMING_KEYS = [
	'title',
	'name',
	'label',
	'heading',
	'platform',
	'key',
	'question',
	'type',
	'slug',
	'id',
	'alt',
	'caption',
]

/** Keys that hold a link worth showing next to the name. */
const LINK_KEYS = ['url', 'href', 'link', 'src', 'website']

const MAX_SUMMARY = 80

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** `https://www.linkedin.com/in/someone` → `linkedin.com/in/someone`. */
export function shortenUrl(url: string): string {
	return url
		.replace(/^[a-z]+:\/\//i, '')
		.replace(/^www\./i, '')
		.replace(/\/$/, '')
}

/** A scalar (or a locale map) as display text; `null` when there is nothing to show. */
export function scalarText(value: unknown, locale?: string): string | null {
	if (value === null || value === undefined) return null
	if (typeof value === 'string') return value.trim() || null
	if (typeof value === 'number' || typeof value === 'bigint') return String(value)
	if (typeof value === 'boolean') return value ? '✓' : '✗'
	if (isPlainObject(value)) {
		// A locale map: show the active language, else the first filled one.
		if (isLocaleMap(value, locale ? [locale] : [])) {
			const preferred = locale ? value[locale] : undefined
			if (typeof preferred === 'string' && preferred.trim()) return preferred.trim()
			const first = Object.values(value).find((v) => typeof v === 'string' && v.trim())
			return first ? String(first).trim() : null
		}
	}
	return null
}

function truncate(text: string): string {
	return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text
}

/**
 * Summarise a row or nested object. Returns `null` when the value holds nothing
 * presentable, so the caller can show its own "empty" label.
 */
export function summarizeValue(
	value: unknown,
	opts: { summaryKey?: string; locale?: string } = {},
): string | null {
	if (Array.isArray(value)) return null
	if (!isPlainObject(value)) {
		const text = scalarText(value, opts.locale)
		return text ? truncate(text) : null
	}
	const keys = Object.keys(value)
	const nameKey =
		(opts.summaryKey && scalarText(value[opts.summaryKey], opts.locale) !== null
			? opts.summaryKey
			: undefined) ??
		NAMING_KEYS.find((key) => scalarText(value[key], opts.locale) !== null) ??
		keys.find(
			(key) =>
				!LINK_KEYS.includes(key) &&
				typeof value[key] === 'string' &&
				scalarText(value[key], opts.locale) !== null,
		)
	const linkKey = LINK_KEYS.find(
		(key) => key !== nameKey && typeof value[key] === 'string' && String(value[key]).trim(),
	)
	const parts: string[] = []
	if (nameKey) parts.push(String(scalarText(value[nameKey], opts.locale)))
	if (linkKey) parts.push(shortenUrl(String(value[linkKey]).trim()))
	// Nothing name-like: the first couple of filled scalar values.
	const fallback = keys
		.map((key) => scalarText(value[key], opts.locale))
		.filter((text): text is string => text !== null)
		.slice(0, 2)
	const shown = parts.length > 0 ? parts : fallback
	if (shown.length > 0) return truncate(shown.join(' · '))
	// Only nested objects: describe the first one that has something to show.
	for (const key of keys) {
		if (!isPlainObject(value[key])) continue
		const nested = summarizeValue(value[key], { locale: opts.locale })
		if (nested) return truncate(`${humanizeKey(key)}: ${nested}`)
	}
	return null
}

/** `homeworkAfterLesson` / `homework_after_lesson` → `Homework after lesson`. */
export function humanizeKey(name: string): string {
	const spaced = name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
	return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}
