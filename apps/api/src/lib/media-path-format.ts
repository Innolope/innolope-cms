/**
 * How an imported media library stores values in its path column.
 *
 * This matters because the CMS is not the only reader. The customer's own site
 * queries their database directly, so anything we *write* into that column has
 * to look like what the source system already writes — a shape the CMS happens
 * to understand on read is not good enough. Guessing wrong produced
 * `https://theirsite/<cloudflare-image-id>` on a live page.
 *
 * So: sample the column when a collection is imported or synced, classify the
 * shape, record it, and format new values the same way.
 */

export const MEDIA_PATH_FORMATS = [
	/** `https://imagedelivery.net/<hash>/<id>/<variant>` — complete and servable. */
	'delivery-url-variant',
	/** `https://imagedelivery.net/<hash>/<id>` — Cloudflare needs a variant appended to render. */
	'delivery-url',
	/** Any other absolute URL, e.g. `https://cdn.example.com/a.jpg`. */
	'absolute-url',
	/** Root-relative path served by the app itself, e.g. `/uploads/a.jpg`. */
	'root-path',
	/** Bare object key inside a bucket, e.g. `2024/a.jpg`. */
	'storage-key',
	/** Bare provider id with no host or extension, e.g. a Cloudflare Images UUID. */
	'image-id',
] as const

export type MediaPathFormat = (typeof MEDIA_PATH_FORMATS)[number]

export const CLOUDFLARE_IMAGES_HOST = 'imagedelivery.net'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ClassifiedMediaPath {
	format: MediaPathFormat
	/** Variant segment, only for `delivery-url-variant`. */
	variant?: string
}

/** Classify a single stored value. */
export function classifyMediaPath(value: string): ClassifiedMediaPath {
	const trimmed = value.trim()

	if (/^https?:\/\//i.test(trimmed)) {
		let parsed: URL
		try {
			parsed = new URL(trimmed)
		} catch {
			return { format: 'absolute-url' }
		}
		if (parsed.hostname.endsWith(CLOUDFLARE_IMAGES_HOST)) {
			// /<accountHash>/<imageId>[/<variant>]
			const parts = parsed.pathname.split('/').filter(Boolean)
			if (parts.length >= 3) return { format: 'delivery-url-variant', variant: parts[2] }
			return { format: 'delivery-url' }
		}
		return { format: 'absolute-url' }
	}

	if (trimmed.startsWith('/')) return { format: 'root-path' }
	if (trimmed.includes('/')) return { format: 'storage-key' }
	// No host, no slash: a bare id if it looks like one, otherwise a flat key
	// (`mami.png` is a key with an extension, not an id).
	if (UUID_RE.test(trimmed) || !trimmed.includes('.')) return { format: 'image-id' }
	return { format: 'storage-key' }
}

/**
 * Below this share of matching rows a detection is not trusted enough to be
 * committed silently — the user has to confirm the format in Settings.
 */
export const MEDIA_FORMAT_CONFIDENCE_THRESHOLD = 0.8

export interface DetectedMediaPathFormat extends ClassifiedMediaPath {
	/** How many sampled values matched the winning format. */
	matched: number
	/** How many values were classified in total. */
	sampled: number
	/** Share of sampled rows matching the winner (`matched / sampled`, 0..1). */
	confidence: number
	/**
	 * True when the sample doesn't clearly agree on one shape — the runner-up
	 * holds a substantial share (≥25%) or the winner is below the confidence
	 * threshold. Mixed detections must not be committed without a human.
	 */
	mixed: boolean
	/** Every format seen, most common first — surfaced so the user can override. */
	breakdown: Array<{ format: MediaPathFormat; count: number; variant?: string }>
	/**
	 * The account's variant name learned from any `delivery-url-variant` rows in
	 * the sample — available even when another format wins, so a library that
	 * mixes bare ids with a few complete URLs still reveals what its variant is
	 * called (it is not always `public`).
	 */
	suggestedVariant?: string
}

/**
 * Classify a sample of stored values and pick the dominant shape.
 *
 * A plain majority is deliberate: real libraries are messy (a handful of rows
 * hand-edited, or written by an older version of the source app), and the shape
 * we should imitate is the one most rows already use. The full breakdown comes
 * back so the caller can show its working and let a human override.
 */
export function detectMediaPathFormat(values: string[]): DetectedMediaPathFormat | null {
	const usable = values.filter((v) => typeof v === 'string' && v.trim())
	if (usable.length === 0) return null

	const counts = new Map<string, { format: MediaPathFormat; variant?: string; count: number }>()
	for (const value of usable) {
		const { format, variant } = classifyMediaPath(value)
		// Variants are counted per format so a library using `public` everywhere
		// keeps that variant rather than a one-off `thumbnail` row winning.
		const key = `${format}::${variant ?? ''}`
		const existing = counts.get(key)
		if (existing) existing.count++
		else counts.set(key, { format, variant, count: 1 })
	}

	const breakdown = [...counts.values()].sort((a, b) => b.count - a.count)
	const suggestedVariant = breakdown.find(
		(b) => b.format === 'delivery-url-variant' && b.variant,
	)?.variant

	// The winning *format* is judged on aggregate counts: two variants of the
	// same format still agree on the shape to write, while a bare-id/full-URL
	// split does not. The winning variant is the most common one within that
	// format (breakdown is already sorted).
	const perFormat = new Map<MediaPathFormat, number>()
	for (const b of breakdown) {
		perFormat.set(b.format, (perFormat.get(b.format) ?? 0) + b.count)
	}
	const [winnerFormat, matched] = [...perFormat.entries()].sort((a, b) => b[1] - a[1])[0]
	const winnerVariant = breakdown.find((b) => b.format === winnerFormat)?.variant
	const runnerUp = Math.max(
		0,
		...[...perFormat.entries()].filter(([f]) => f !== winnerFormat).map(([, c]) => c),
	)
	const confidence = matched / usable.length
	const mixed = runnerUp >= usable.length * 0.25 || confidence < MEDIA_FORMAT_CONFIDENCE_THRESHOLD

	return {
		format: winnerFormat,
		variant: winnerVariant,
		matched,
		sampled: usable.length,
		confidence,
		mixed,
		breakdown: breakdown.map((b) => ({ format: b.format, count: b.count, variant: b.variant })),
		suggestedVariant,
	}
}

export interface UploadedFileRef {
	/** Provider id, when the backend has one (Cloudflare Images). */
	id?: string
	/** Complete delivery URL, when the backend can build one. */
	url?: string
	/** Object key inside the bucket (R2/S3). */
	key?: string
	/** Account hash, needed to rebuild a Cloudflare delivery URL. */
	accountHash?: string
}

/**
 * Render a freshly-uploaded file as a value in the library's own format, so the
 * row we add is indistinguishable from the ones the source system writes.
 *
 * Falls back to the most complete value available whenever the recorded format
 * can't be produced from what the backend returned — a usable absolute URL is a
 * better failure mode than a value nothing can resolve.
 */
export function formatMediaPath(
	ref: UploadedFileRef,
	format: MediaPathFormat | undefined,
	variant?: string,
): string {
	const fallback = ref.url || ref.key || ref.id || ''

	switch (format) {
		case 'image-id':
			return ref.id || fallback
		case 'storage-key':
			return ref.key || ref.id || fallback
		case 'root-path': {
			const key = ref.key || ref.id
			return key ? `/${key.replace(/^\//, '')}` : fallback
		}
		case 'delivery-url':
			return ref.id && ref.accountHash
				? `https://${CLOUDFLARE_IMAGES_HOST}/${ref.accountHash}/${ref.id}`
				: fallback
		case 'delivery-url-variant':
			return ref.id && ref.accountHash
				? `https://${CLOUDFLARE_IMAGES_HOST}/${ref.accountHash}/${ref.id}/${variant || 'public'}`
				: fallback
		default:
			// No recorded format (a library imported before detection existed): the
			// complete URL is the safest default — it resolves everywhere.
			return fallback
	}
}
