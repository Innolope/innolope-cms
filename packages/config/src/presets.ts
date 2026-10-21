/**
 * Shape presets: a vocabulary above "object" and "array".
 *
 * `{ url, alt, width, height }` is an image, `{ amount, currency }` is money,
 * `[{ key, value }]` is a key-value table. A preset is matched by the keys and
 * value types a field holds across a sample of records, recorded on the field
 * as `ui.preset` (with the document's own key names in `ui.presetKeys`), and
 * rendered as one control instead of a generic subform.
 *
 * Shared by the API (detection at scan time) and the admin (controls, list
 * cells, the field designer), so the two always agree on what a shape means.
 */

import type { CollectionField } from './templates.js'

export type PresetId =
	| 'image'
	| 'link'
	| 'social-link'
	| 'seo'
	| 'money'
	| 'geo-point'
	| 'address'
	| 'date-range'
	| 'key-value'
	| 'rich-text'

/** The kind of value a preset describes. */
export type PresetTarget =
	/** A plain object (`{ url, alt }`). */
	| 'object'
	/** An array whose elements are the preset's object (`[{ platform, url }]`). */
	| 'rows'
	/** A string (an image URL). */
	| 'text'
	/** An array that IS the preset (`[{ key, value }]` as one key-value table). */
	| 'array'

export interface PresetRole {
	/** Canonical name the control uses. */
	role: string
	/** Keys a document may use for this role, preferred first. */
	aliases: string[]
	type: CollectionField['type']
	required?: boolean
}

export interface FieldPreset {
	id: PresetId
	/** English label; the admin translates by id. */
	label: string
	targets: PresetTarget[]
	roles: PresetRole[]
	/** Role that titles a collapsed row. */
	summaryRole?: string
}

export const FIELD_PRESETS: FieldPreset[] = [
	{
		id: 'image',
		label: 'Image',
		targets: ['object', 'text'],
		roles: [
			{ role: 'url', aliases: ['url', 'src', 'href', 'path'], type: 'text', required: true },
			{ role: 'alt', aliases: ['alt', 'altText', 'alt_text', 'caption', 'title'], type: 'text' },
			{ role: 'width', aliases: ['width', 'w'], type: 'number' },
			{ role: 'height', aliases: ['height', 'h'], type: 'number' },
		],
		summaryRole: 'alt',
	},
	{
		id: 'link',
		label: 'Link',
		targets: ['object', 'rows'],
		roles: [
			{ role: 'label', aliases: ['label', 'title', 'text', 'name'], type: 'text', required: true },
			{ role: 'url', aliases: ['url', 'href', 'link'], type: 'text', required: true },
		],
		summaryRole: 'label',
	},
	{
		id: 'social-link',
		label: 'Social link',
		targets: ['object', 'rows'],
		roles: [
			{
				role: 'platform',
				aliases: ['platform', 'network', 'service', 'type'],
				type: 'enum',
				required: true,
			},
			{ role: 'url', aliases: ['url', 'href', 'link'], type: 'text', required: true },
		],
		summaryRole: 'platform',
	},
	{
		id: 'seo',
		label: 'SEO',
		targets: ['object'],
		roles: [
			{
				role: 'title',
				aliases: ['title', 'metaTitle', 'meta_title'],
				type: 'text',
				required: true,
			},
			{
				role: 'description',
				aliases: ['description', 'metaDescription', 'meta_description'],
				type: 'text',
				required: true,
			},
			{ role: 'keywords', aliases: ['keywords', 'tags'], type: 'array' },
			{ role: 'ogImage', aliases: ['ogImage', 'og_image', 'image', 'shareImage'], type: 'text' },
			{ role: 'canonical', aliases: ['canonical', 'canonicalUrl', 'canonical_url'], type: 'text' },
			{ role: 'noindex', aliases: ['noindex', 'noIndex', 'no_index'], type: 'boolean' },
		],
		summaryRole: 'title',
	},
	{
		id: 'money',
		label: 'Money',
		targets: ['object'],
		roles: [
			{ role: 'amount', aliases: ['amount', 'value', 'price'], type: 'number', required: true },
			{
				role: 'currency',
				aliases: ['currency', 'currencyCode', 'currency_code'],
				type: 'text',
				required: true,
			},
		],
	},
	{
		id: 'geo-point',
		label: 'Map point',
		targets: ['object'],
		roles: [
			{ role: 'lat', aliases: ['lat', 'latitude'], type: 'number', required: true },
			{ role: 'lng', aliases: ['lng', 'lon', 'long', 'longitude'], type: 'number', required: true },
		],
	},
	{
		id: 'address',
		label: 'Address',
		targets: ['object'],
		roles: [
			{
				role: 'street',
				aliases: ['street', 'line1', 'address1', 'addressLine1', 'street1'],
				type: 'text',
			},
			{ role: 'line2', aliases: ['line2', 'address2', 'addressLine2', 'street2'], type: 'text' },
			{ role: 'city', aliases: ['city', 'town', 'locality'], type: 'text', required: true },
			{ role: 'region', aliases: ['state', 'region', 'province', 'county'], type: 'text' },
			{
				role: 'postalCode',
				aliases: ['postalCode', 'postal_code', 'zip', 'zipCode', 'postcode'],
				type: 'text',
			},
			{ role: 'country', aliases: ['country', 'countryCode', 'country_code'], type: 'text' },
		],
		summaryRole: 'city',
	},
	{
		id: 'date-range',
		label: 'Date range',
		targets: ['object'],
		roles: [
			{
				role: 'start',
				aliases: ['start', 'from', 'startDate', 'start_date', 'begin'],
				type: 'date',
				required: true,
			},
			{
				role: 'end',
				aliases: ['end', 'to', 'endDate', 'end_date', 'until'],
				type: 'date',
				required: true,
			},
		],
	},
	{
		id: 'key-value',
		label: 'Key-value table',
		targets: ['array'],
		roles: [
			{ role: 'key', aliases: ['key', 'name', 'label'], type: 'text', required: true },
			{ role: 'value', aliases: ['value', 'val'], type: 'text', required: true },
		],
		summaryRole: 'key',
	},
	{
		id: 'rich-text',
		label: 'Rich text',
		targets: ['object', 'array'],
		roles: [],
	},
]

export function getPreset(id: string | undefined): FieldPreset | undefined {
	return id ? FIELD_PRESETS.find((preset) => preset.id === id) : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?.*)?$/i
const IMAGE_HOST_RE =
	/(^|\.)(images\.unsplash\.com|res\.cloudinary\.com|imagedelivery\.net|i\.imgur\.com|cdn\.sanity\.io|images\.ctfassets\.net|imgix\.net|googleusercontent\.com|cloudfront\.net)$/i

/** Whether a string looks like the URL of an image. */
export function looksLikeImageUrl(value: unknown): boolean {
	if (typeof value !== 'string') return false
	const text = value.trim()
	if (!/^(https?:)?\/\//i.test(text) && !text.startsWith('/')) return false
	if (IMAGE_EXT_RE.test(text)) return true
	const host = /^(?:https?:)?\/\/([^/?#:]+)/i.exec(text)?.[1]
	return host ? IMAGE_HOST_RE.test(host) : false
}

function fitsType(value: unknown, type: CollectionField['type']): boolean {
	if (value === null || value === undefined) return true
	switch (type) {
		case 'number':
			return (
				(typeof value === 'number' && Number.isFinite(value)) ||
				(typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
			)
		case 'boolean':
			return typeof value === 'boolean'
		case 'date':
			return (
				value instanceof Date ||
				(typeof value === 'string' && ISO_DATE_RE.test(value)) ||
				(typeof value === 'number' && value > 0)
			)
		case 'array':
			return Array.isArray(value) || typeof value === 'string'
		case 'enum':
		case 'text':
			return typeof value === 'string'
		default:
			return true
	}
}

/**
 * Map each role to the key a value uses for it. Returns null when a required
 * role has no key or a value has the wrong type.
 */
export function resolvePresetKeys(
	preset: FieldPreset,
	value: Record<string, unknown>,
): Record<string, string> | null {
	const keys: Record<string, string> = {}
	const used = new Set<string>()
	for (const role of preset.roles) {
		const key = role.aliases.find((alias) => alias in value && !used.has(alias))
		if (!key) {
			if (role.required) return null
			continue
		}
		if (!fitsType(value[key], role.type)) return null
		keys[role.role] = key
		used.add(key)
	}
	return keys
}

/** Signature checks beyond key names: what makes a shape *this* preset. */
function matchesObject(
	preset: FieldPreset,
	value: Record<string, unknown>,
): Record<string, string> | null {
	const keys = resolvePresetKeys(preset, value)
	if (!keys) return null
	const extra = Object.keys(value).filter((key) => !Object.values(keys).includes(key))
	switch (preset.id) {
		case 'image': {
			const url = value[keys.url]
			// A bare `{ url }` is too generic; it needs a sibling that only images have,
			// or a URL that is evidently an image.
			// `title` and `caption` also name a link's text, so only a real alt key counts.
			const imageish =
				looksLikeImageUrl(url) ||
				'width' in keys ||
				'height' in keys ||
				['alt', 'altText', 'alt_text'].includes(keys.alt)
			return imageish && extra.length <= 2 ? keys : null
		}
		case 'link':
			return extra.length === 0 && typeof value[keys.url] === 'string' ? keys : null
		case 'social-link':
			return extra.length <= 1 ? keys : null
		case 'seo':
			return extra.length <= 2 ? keys : null
		case 'money': {
			const currency = value[keys.currency]
			return typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) && extra.length <= 1
				? keys
				: null
		}
		case 'geo-point': {
			const lat = Number(value[keys.lat])
			const lng = Number(value[keys.lng])
			return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && extra.length <= 1 ? keys : null
		}
		case 'address': {
			const filled = Object.keys(keys).length
			return filled >= 3 && extra.length <= 2 ? keys : null
		}
		case 'date-range':
			return extra.length <= 1 ? keys : null
		default:
			return null
	}
}

/** GeoJSON `{ type: 'Point', coordinates: [lng, lat] }`. */
function isGeoJsonPoint(value: unknown): boolean {
	return (
		isPlainObject(value) &&
		value.type === 'Point' &&
		Array.isArray(value.coordinates) &&
		value.coordinates.length >= 2 &&
		value.coordinates.every((n) => typeof n === 'number')
	)
}

/** Lexical/Slate/Editor.js/Portable Text editor state. See `detectRichTextFormat`. */
export type RichTextFormat = 'lexical' | 'slate' | 'editorjs' | 'portable-text'

export function detectRichTextFormat(value: unknown): RichTextFormat | null {
	if (isPlainObject(value)) {
		const root = value.root
		if (isPlainObject(root) && root.type === 'root' && Array.isArray(root.children))
			return 'lexical'
		if (
			Array.isArray(value.blocks) &&
			value.blocks.length > 0 &&
			value.blocks.every(
				(block) => isPlainObject(block) && typeof block.type === 'string' && 'data' in block,
			)
		) {
			return 'editorjs'
		}
		return null
	}
	if (Array.isArray(value) && value.length > 0) {
		if (value.every((block) => isPlainObject(block) && typeof block._type === 'string')) {
			return value.some((block) => (block as { _type: string })._type === 'block')
				? 'portable-text'
				: null
		}
		if (
			value.every(
				(node) =>
					isPlainObject(node) && Array.isArray(node.children) && typeof node.type === 'string',
			)
		) {
			return 'slate'
		}
	}
	return null
}

export interface PresetMatch {
	preset: PresetId
	/** Role → the key this field's documents use for it. */
	keys: Record<string, string>
}

/** Match one value against the catalogue. */
export function matchPresetValue(
	value: unknown,
	type: CollectionField['type'],
): PresetMatch | null {
	if (value === null || value === undefined) return null
	if (detectRichTextFormat(value)) return { preset: 'rich-text', keys: {} }
	if (type === 'text' && looksLikeImageUrl(value)) return { preset: 'image', keys: {} }
	if (type === 'object' && isGeoJsonPoint(value))
		return { preset: 'geo-point', keys: { geojson: 'coordinates' } }
	if (type === 'object' && isPlainObject(value)) {
		for (const preset of FIELD_PRESETS) {
			if (!preset.targets.includes('object') || preset.id === 'rich-text') continue
			const keys = matchesObject(preset, value)
			if (keys) return { preset: preset.id, keys }
		}
		return null
	}
	if (type === 'array' && Array.isArray(value) && value.length > 0) {
		if (!value.every(isPlainObject)) return null
		// `[{ key, value }]`: two keys per row, the same two everywhere.
		const keyValue = getPreset('key-value') as FieldPreset
		const kvKeys = value.map((item) =>
			Object.keys(item as object).length === 2
				? resolvePresetKeys(keyValue, item as Record<string, unknown>)
				: null,
		)
		const firstKv = kvKeys[0]
		if (firstKv && kvKeys.every((keys) => keys && sameKeys(keys, firstKv))) {
			return { preset: 'key-value', keys: firstKv }
		}
		for (const preset of FIELD_PRESETS) {
			if (!preset.targets.includes('rows')) continue
			const matches = value.map((item) => matchesObject(preset, item as Record<string, unknown>))
			const first = matches[0]
			if (first && matches.every((keys) => keys && sameKeys(keys, first))) {
				return { preset: preset.id, keys: first }
			}
		}
	}
	return null
}

function sameKeys(a: Record<string, string>, b: Record<string, string>): boolean {
	const ka = Object.keys(a)
	return ka.length === Object.keys(b).length && ka.every((key) => a[key] === b[key])
}

/**
 * Detect a field's preset over a sample of its values. A preset needs agreement:
 * at least two values match it with the same key mapping, or the only value in
 * a near-empty sample does — the same threshold locale-map detection uses. Any
 * filled value that does not match vetoes the preset.
 */
export function detectFieldPreset(
	values: unknown[],
	type: CollectionField['type'],
): PresetMatch | null {
	const filled = values.filter(
		(value) =>
			value !== null &&
			value !== undefined &&
			value !== '' &&
			!(Array.isArray(value) && value.length === 0),
	)
	if (filled.length === 0) return null
	const matches = filled.map((value) => matchPresetValue(value, type))
	const first = matches[0]
	if (!first) return null
	if (
		!matches.every(
			(match) => match && match.preset === first.preset && sameKeys(match.keys, first.keys),
		)
	) {
		return null
	}
	return filled.length >= Math.min(2, values.length) ? first : null
}
