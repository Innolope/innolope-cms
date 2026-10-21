/**
 * Describing a source table's real shape — what the database stores, as opposed
 * to the editor-facing `collections.fields` projection built from it.
 *
 * SQL targets describe themselves through `information_schema`. MongoDB has no
 * schema, so its descriptor is a histogram of the BSON types seen at every path
 * of a sample, nested paths and array elements included. Both reduce to a hash
 * of the shape alone, so a re-scan that samples different documents but finds
 * the same structure does not read as drift.
 */

import { createHash } from 'node:crypto'
import type { SourcePath, SourceSchema } from '@innolope/db'

/** BSON type name of a value as the Node driver returns it. */
export function bsonTypeOf(value: unknown): string {
	if (value === null || value === undefined) return 'null'
	if (value instanceof Date) return 'date'
	if (Array.isArray(value)) return 'array'
	const bsontype = (value as { _bsontype?: string })?._bsontype
	if (bsontype) {
		switch (bsontype) {
			case 'ObjectId':
			case 'ObjectID':
				return 'objectId'
			case 'Decimal128':
				return 'decimal128'
			case 'Long':
				return 'long'
			case 'Int32':
			case 'Double':
				return 'number'
			case 'Binary':
				return 'binary'
			case 'Timestamp':
				return 'timestamp'
			default:
				return bsontype.toLowerCase()
		}
	}
	switch (typeof value) {
		case 'string':
			return 'string'
		case 'number':
			// The driver promotes int32 and double alike to a JS number; telling them
			// apart after the fact would flag every `5.0` as a mixed-type field.
			return 'number'
		case 'boolean':
			return 'bool'
		case 'bigint':
			return 'long'
		case 'object':
			return 'object'
		default:
			return 'other'
	}
}

/** Deepest path the histogram descends to; deeper values count at their parent. */
const MAX_PATH_DEPTH = 6

/**
 * Tally the BSON types at every path of a document sample. Arrays contribute
 * their elements under `<path>[]`; embedded documents contribute their keys.
 * A path missing from some documents, or holding null, is marked nullable.
 */
export function histogramPaths(docs: Array<Record<string, unknown>>): SourcePath[] {
	const tallies = new Map<
		string,
		{ types: Map<string, number>; docs: Set<number>; counted: Set<string> }
	>()
	const record = (path: string, type: string, docIndex: number) => {
		let entry = tallies.get(path)
		if (!entry) {
			entry = { types: new Map(), docs: new Set(), counted: new Set() }
			tallies.set(path, entry)
		}
		// Count each type once per document, so a long array of ids does not
		// outweigh the other documents in the sample.
		const key = `${docIndex}:${type}`
		if (!entry.counted.has(key)) {
			entry.counted.add(key)
			entry.types.set(type, (entry.types.get(type) ?? 0) + 1)
		}
		entry.docs.add(docIndex)
	}
	const walk = (value: unknown, path: string, depth: number, docIndex: number) => {
		const type = bsonTypeOf(value)
		record(path, type, docIndex)
		if (depth >= MAX_PATH_DEPTH) return
		if (type === 'array') {
			for (const item of value as unknown[]) walk(item, `${path}[]`, depth + 1, docIndex)
		} else if (type === 'object') {
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				walk(child, `${path}.${key}`, depth + 1, docIndex)
			}
		}
	}
	docs.forEach((doc, docIndex) => {
		for (const [key, value] of Object.entries(doc)) {
			if (key === '_id') continue
			walk(value, key, 1, docIndex)
		}
	})

	const paths: SourcePath[] = []
	for (const [path, { types, docs: seenIn }] of tallies) {
		const nonNull = [...types.keys()].filter((type) => type !== 'null')
		// A top-level key absent from some documents is as good as null to a reader.
		const topLevel = !path.includes('.') && !path.includes('[]')
		const missing = topLevel && seenIn.size < docs.length
		paths.push({
			path,
			types: Object.fromEntries(types),
			...((types.has('null') || missing) && { nullable: true }),
			...(nonNull.length > 1 && { mixed: true }),
		})
	}
	return paths.sort((a, b) => a.path.localeCompare(b.path))
}

/** The single non-null BSON type at a path, or null when it is absent or mixed. */
export function soleType(path: SourcePath | undefined): string | null {
	if (!path || path.mixed) return null
	const types = Object.keys(path.types).filter((type) => type !== 'null')
	return types.length === 1 ? types[0] : null
}

/**
 * Hash the shape of a descriptor. Sample counts and scan times are left out, so
 * the hash changes only when a column, a type or a constraint does.
 */
export function hashSourceShape(schema: Omit<SourceSchema, 'hash' | 'scannedAt'>): string {
	const shape = {
		dialect: schema.dialect,
		table: schema.table,
		primaryKey: schema.primaryKey,
		columns: schema.columns,
		paths: schema.paths?.map((path) => ({
			path: path.path,
			types: Object.keys(path.types).sort(),
		})),
	}
	return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32)
}

/** Finish a descriptor: stamp its shape hash and scan time. */
export function sealSourceSchema(schema: Omit<SourceSchema, 'hash' | 'scannedAt'>): SourceSchema {
	return { ...schema, hash: hashSourceShape(schema), scannedAt: new Date().toISOString() }
}

/** `enum('a','b')` → `['a', 'b']`, unescaping doubled quotes. */
export function parseMysqlEnumValues(columnType: string): string[] | undefined {
	const match = /^(?:enum|set)\((.*)\)$/i.exec(columnType.trim())
	if (!match) return undefined
	const values: string[] = []
	const re = /'((?:[^']|'')*)'/g
	for (let found = re.exec(match[1]); found; found = re.exec(match[1])) {
		values.push(found[1].replace(/''/g, "'"))
	}
	return values
}
