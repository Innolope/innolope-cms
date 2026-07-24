/**
 * Health checks for imported media libraries.
 *
 * The CMS's read side normalizes stored values into servable URLs, which means
 * a row can render fine in the CMS while the customer's site — which reads the
 * raw column straight from their database — gets a broken image. These checks
 * judge the RAW stored value exactly as the customer's site sees it, so that
 * class of bug is surfaced instead of masked.
 *
 * Pure logic only (no I/O) so it is unit-testable; the route layer does the
 * HTTP probing and database writes.
 */
import { classifyMediaPath } from './media-path-format.js'
import { cloudflareImageUrl } from './media-sign.js'
import type { MediaStorageEntry } from './media-storage.js'

export interface MediaValueLint {
	/** Machine-readable problem tags, empty when the value looks structurally sound. */
	problems: string[]
	/**
	 * A deterministic replacement value, present only when the problem has an
	 * unambiguous repair (missing variant, bare id in a full-URL library). The
	 * route verifies it over HTTP before it is ever offered, and again before
	 * it is written.
	 */
	suggestedFix?: string
	/** False when the row can only be fixed by re-uploading the file. */
	repairable: boolean
}

/** Statically lint a raw stored value against its library's configuration. */
export function lintMediaValue(raw: string, entry: MediaStorageEntry): MediaValueLint {
	const problems: string[] = []
	let suggestedFix: string | undefined
	const trimmed = raw.trim()
	const classified = classifyMediaPath(trimmed)
	const accountHash = entry.credentials?.accountHash
	const variant = entry.pathVariant || 'public'

	if (entry.pathFormat && classified.format !== entry.pathFormat) {
		problems.push(`shape-mismatch:${classified.format}`)
	}

	if (/^https?:\/\//i.test(trimmed)) {
		let parsed: URL | undefined
		try {
			parsed = new URL(trimmed)
		} catch {
			problems.push('malformed-url')
		}
		if (parsed?.hostname.endsWith('imagedelivery.net')) {
			// A delivery URL is /<hash>/<id>/<variant>; custom image ids may contain
			// slashes, so segment count alone proves nothing — but an *empty*
			// segment (`//`) means the value was glued together from a base URL and
			// a rooted path. Cloudflare never issued that id, so only a re-upload
			// can fix it.
			if (parsed.pathname.includes('//')) {
				problems.push('empty-path-segment')
				return { problems, repairable: false }
			}
			const parts = parsed.pathname.split('/').filter(Boolean)
			if (parts.length === 2) {
				problems.push('missing-variant')
				suggestedFix = `${trimmed.replace(/\/+$/, '')}/${variant}`
			}
		}
	} else if (
		(classified.format === 'image-id' || classified.format === 'storage-key') &&
		entry.pathFormat === 'delivery-url-variant' &&
		accountHash
	) {
		// A bare id in a library that stores complete URLs: the customer's site
		// resolves it relative to its own origin. The complete URL is derivable.
		suggestedFix = cloudflareImageUrl(accountHash, trimmed, entry.pathVariant)
	}

	return { problems, suggestedFix, repairable: true }
}

/**
 * The URL the customer's own site ends up requesting for this raw value, or
 * null when that cannot be known from configuration (private storage that the
 * site presigns itself, or a relative value with no base URL).
 */
export function customerVisibleUrl(raw: string, entry: MediaStorageEntry): string | null {
	const trimmed = raw.trim()
	if (/^https?:\/\//i.test(trimmed)) return trimmed
	if (entry.access !== 'private' && entry.baseUrl) {
		return `${entry.baseUrl.replace(/\/$/, '')}/${trimmed.replace(/^\//, '')}`
	}
	return null
}

export type MediaHealthVerdict = 'ok' | 'broken' | 'masked' | 'skipped'

export interface MediaHealthRow {
	externalId: string
	rawValue: string
	verdict: MediaHealthVerdict
	problems: string[]
	/** Only set for broken/masked rows with a deterministic repair. */
	suggestedFix?: string
	repairable: boolean
	/** True when only a signed URL could be probed (private library). */
	signedCheckOnly?: boolean
}

export interface MediaHealthSummary {
	total: number
	ok: number
	broken: number
	masked: number
	skipped: number
}

export function summarizeMediaHealth(rows: MediaHealthRow[]): MediaHealthSummary {
	return {
		total: rows.length,
		ok: rows.filter((r) => r.verdict === 'ok').length,
		broken: rows.filter((r) => r.verdict === 'broken').length,
		masked: rows.filter((r) => r.verdict === 'masked').length,
		skipped: rows.filter((r) => r.verdict === 'skipped').length,
	}
}
