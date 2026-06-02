import type { CollectionField } from '@innolope/config'

/** Classify a runtime MongoDB value into a CollectionField type. */
export function classifyMongoValue(value: unknown): {
	type: string
	isObjectId: boolean
	isArray: boolean
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
	if (t === 'string') return { type: 'text', isObjectId: false, isArray: false }
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

/**
 * Sample documents from the named MongoDB collections and return the union of
 * 2-character keys found in object-valued fields whose values are strings
 * across multiple documents. This is the convention this CMS uses for
 * localized text (`{ en: "...", ua: "..." }`) — so the set of keys is a
 * faithful proxy for which locales the data is authored in.
 *
 * Bounded: samples at most 20 docs per collection and only inspects the top
 * level of each document. A key needs ≥2 string-valued occurrences across all
 * samples to qualify, which keeps incidental short-keyed objects (e.g. a
 * configuration blob with a 2-letter shortcode) from polluting the result.
 */
export async function detectMongoLocales(
	connectionString: string,
	database: string | undefined,
	tableNames: string[],
): Promise<string[]> {
	const { MongoClient } = await import('mongodb')
	const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 10000 })
	try {
		await client.connect()
		const db = database ? client.db(database) : client.db()
		const counts = new Map<string, number>()
		for (const name of tableNames) {
			let samples: unknown[] = []
			try {
				samples = await db.collection(name).find().limit(20).toArray()
			} catch {
				continue
			}
			for (const doc of samples) {
				if (!doc || typeof doc !== 'object') continue
				for (const value of Object.values(doc as Record<string, unknown>)) {
					if (!value || typeof value !== 'object' || Array.isArray(value)) continue
					for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
						// Only keep plausible 2-letter ISO-ish codes mapping to non-empty
						// strings; rules out `_id`/`__v`/numeric flags/etc.
						if (typeof v !== 'string' || v.length === 0) continue
						if (!/^[a-z]{2}$/.test(k)) continue
						counts.set(k, (counts.get(k) ?? 0) + 1)
					}
				}
			}
		}
		return [...counts.entries()].filter(([, n]) => n >= 2).map(([code]) => code)
	} finally {
		await client.close().catch(() => undefined)
	}
}
