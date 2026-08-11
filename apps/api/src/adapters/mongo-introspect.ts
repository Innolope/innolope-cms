import type { CollectionField } from '@innolope/config'

/**
 * A full ISO-8601 date-time. Deliberately strict: a bare `2026-07-27` or any
 * other loosely date-shaped string stays text, because `new Date()` accepts far
 * too much (`"7"` parses) and mislabelling a real text column as a date would
 * hand the editor a picker that mangles the value on save.
 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Whether a string is a full ISO-8601 timestamp that also parses as a real date. */
export function isIsoDateTimeString(value: unknown): boolean {
	if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value)) return false
	return !Number.isNaN(new Date(value).getTime())
}

/** Classify a runtime MongoDB value into a CollectionField type. */
export function classifyMongoValue(value: unknown): {
	type: string
	isObjectId: boolean
	isArray: boolean
	/** Set for strings that are full ISO-8601 timestamps (see `isIsoDateTimeString`). */
	isIsoDate?: boolean
} {
	if (value === null || value === undefined)
		return { type: 'unknown', isObjectId: false, isArray: false }
	if (typeof value === 'object' && (value as { _bsontype?: string })._bsontype === 'ObjectId') {
		return { type: 'relation', isObjectId: true, isArray: false }
	}
	if (value instanceof Date) return { type: 'date', isObjectId: false, isArray: false }
	if (Array.isArray(value)) {
		const first = value[0]
		if (
			first &&
			typeof first === 'object' &&
			(first as { _bsontype?: string })._bsontype === 'ObjectId'
		) {
			return { type: 'relation', isObjectId: true, isArray: true }
		}
		return { type: 'array', isObjectId: false, isArray: true }
	}
	const t = typeof value
	if (t === 'string') {
		// Stays `text` on purpose. The column holds strings and must keep holding
		// them — writing a BSON Date into it would leave one column with two types,
		// which sorts wrong. The flag only upgrades the editor's widget.
		return {
			type: 'text',
			isObjectId: false,
			isArray: false,
			isIsoDate: isIsoDateTimeString(value),
		}
	}
	if (t === 'number') return { type: 'number', isObjectId: false, isArray: false }
	if (t === 'boolean') return { type: 'boolean', isObjectId: false, isArray: false }
	return { type: 'object', isObjectId: false, isArray: false }
}

export interface ObjectArrayShape {
	/** Union of keys observed across sampled array elements (first-appearance order). */
	keys: string[]
	/** Per-key observed string values, used to infer enum options. Bounded to 20 samples per key. */
	stringValues: Map<string, Set<string>>
}

/** Common social-platform values, used to auto-promote a `platform` sub-field to an enum. */
const KNOWN_SOCIAL_PLATFORMS = new Set([
	'linkedin',
	'twitter',
	'x',
	'instagram',
	'facebook',
	'youtube',
	'tiktok',
	'github',
	'mastodon',
	'threads',
	'website',
])

/**
 * Build a sub-field descriptor from a detected key. URL-like keys get
 * `type: 'text'` with a sensible placeholder. The `platform` key is
 * special-cased into an enum if every observed value is in the known
 * social-platforms list — otherwise it stays free-text so a value the user
 * actually relies on isn't silently lost when the editor restricts options.
 */
export function buildSubField(key: string, shape: ObjectArrayShape): CollectionField {
	if (key === 'platform') {
		const seen = shape.stringValues.get(key)
		if (seen && seen.size > 0 && [...seen].every((v) => KNOWN_SOCIAL_PLATFORMS.has(v))) {
			const observed = [...seen]
			const merged = [
				...observed,
				...[...KNOWN_SOCIAL_PLATFORMS].filter((p) => !observed.includes(p)),
			]
			return {
				name: 'platform',
				type: 'enum',
				options: merged,
			}
		}
	}
	return { name: key, type: 'text' }
}

/**
 * Sample documents from the named MongoDB collections and detect, for each
 * array-typed top-level column, the union of keys across object elements
 * (e.g. `socialLinks: [{ platform, url }]`). The shape is used to seed the
 * editor's structured repeater so a new record gets a row with the right
 * fields instead of falling back to a generic pill input.
 */
export async function detectMongoArrayShapes(
	connectionString: string,
	database: string | undefined,
	tableNames: string[],
): Promise<Map<string, Map<string, ObjectArrayShape>>> {
	const { MongoClient } = await import('mongodb')
	const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 10000 })
	const result = new Map<string, Map<string, ObjectArrayShape>>()
	try {
		await client.connect()
		const db = database ? client.db(database) : client.db()
		for (const name of tableNames) {
			let samples: unknown[] = []
			try {
				samples = await db.collection(name).find().limit(20).toArray()
			} catch {
				continue
			}
			const perColumn = new Map<string, ObjectArrayShape>()
			for (const doc of samples) {
				if (!doc || typeof doc !== 'object') continue
				for (const [colName, colValue] of Object.entries(doc as Record<string, unknown>)) {
					if (!Array.isArray(colValue) || colValue.length === 0) continue
					// Only treat as object-array if every sampled element is a plain object
					// (not a string, not an ObjectId). One stray string kills the inference;
					// that's intentional — mixed arrays should stay as the generic pill widget.
					const allObjects = colValue.every(
						(el) => el !== null && typeof el === 'object' && !Array.isArray(el),
					)
					if (!allObjects) continue
					let shape = perColumn.get(colName)
					if (!shape) {
						shape = { keys: [], stringValues: new Map() }
						perColumn.set(colName, shape)
					}
					for (const el of colValue) {
						for (const [k, v] of Object.entries(el as Record<string, unknown>)) {
							if (!shape.keys.includes(k)) shape.keys.push(k)
							if (typeof v === 'string') {
								let set = shape.stringValues.get(k)
								if (!set) {
									set = new Set()
									shape.stringValues.set(k, set)
								}
								if (set.size < 20) set.add(v.toLowerCase())
							}
						}
					}
				}
			}
			if (perColumn.size > 0) result.set(name, perColumn)
		}
	} finally {
		await client.close().catch(() => undefined)
	}
	return result
}

export interface MongoLocaleDetection {
	/** Union of locale codes seen across every sampled collection. */
	locales: string[]
	/** Table name → names of the fields whose values are locale maps. */
	localizedFields: Map<string, Set<string>>
}

/**
 * Sample documents from the named MongoDB collections and detect localized text
 * — fields whose value is a `{ en: "...", ua: "..." }` map, the convention this
 * CMS uses. Returns both the union of locale codes (which seeds
 * `settings.locales`) and, per collection, which fields carry those maps (which
 * marks the schema fields `localized: true`).
 *
 * The per-field result is what lets a write know it must fold a value into the
 * existing map instead of replacing it; without it, writing one language to a
 * bilingual document silently drops the other.
 *
 * Bounded: samples at most 20 docs per collection and only inspects the top
 * level of each document. A code needs ≥2 string-valued occurrences to make the
 * locale union, and a field must look locale-shaped in ≥2 sampled docs (or in
 * the only doc, for a near-empty collection) to be marked localized — which
 * keeps an incidental short-keyed object from being mistaken for translations.
 */
export async function detectMongoLocales(
	connectionString: string,
	database: string | undefined,
	tableNames: string[],
): Promise<MongoLocaleDetection> {
	const { MongoClient } = await import('mongodb')
	const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 10000 })
	try {
		await client.connect()
		const db = database ? client.db(database) : client.db()
		const counts = new Map<string, number>()
		const localizedFields = new Map<string, Set<string>>()
		for (const name of tableNames) {
			let samples: unknown[] = []
			try {
				samples = await db.collection(name).find().limit(20).toArray()
			} catch {
				continue
			}
			// Per-field tally of "this value was locale-shaped in this document".
			const fieldHits = new Map<string, number>()
			for (const doc of samples) {
				if (!doc || typeof doc !== 'object') continue
				for (const [field, value] of Object.entries(doc as Record<string, unknown>)) {
					if (!value || typeof value !== 'object' || Array.isArray(value)) continue
					const entries = Object.entries(value as Record<string, unknown>)
					if (entries.length === 0) continue
					let localeKeys = 0
					for (const [k, v] of entries) {
						// Only keep plausible 2-letter ISO-ish codes mapping to non-empty
						// strings; rules out `_id`/`__v`/numeric flags/etc.
						if (typeof v !== 'string' || v.length === 0) continue
						if (!/^[a-z]{2}$/.test(k)) continue
						counts.set(k, (counts.get(k) ?? 0) + 1)
						localeKeys++
					}
					// Every key must be a locale code for the FIELD to count as localized.
					// A structured blob like `{ platform, url, id }` can contribute a stray
					// code to the union above, but must never mark the field translatable.
					if (localeKeys > 0 && localeKeys === entries.length) {
						fieldHits.set(field, (fieldHits.get(field) ?? 0) + 1)
					}
				}
			}
			const threshold = Math.min(2, samples.length || 1)
			const qualified = new Set(
				[...fieldHits.entries()].filter(([, n]) => n >= threshold).map(([field]) => field),
			)
			if (qualified.size > 0) localizedFields.set(name, qualified)
		}
		return {
			locales: [...counts.entries()].filter(([, n]) => n >= 2).map(([code]) => code),
			localizedFields,
		}
	} finally {
		await client.close().catch(() => undefined)
	}
}
