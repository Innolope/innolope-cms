/**
 * The type-preserving codec between a source database and the CMS cache.
 *
 * The cache is JSON. Some source types survive that only as strings or as
 * `{ $numberDecimal }` objects, and without a codec a write carried those copies
 * back: a nested ObjectId became a string (and the site's `$lookup` stopped
 * matching), a nested Date became a string (and sorted wrong in BSON), a
 * Decimal128 became an embedded document.
 *
 *  - `decodeMongoValue` turns what the driver returns into something JSON can
 *    hold exactly: Decimal128 → string, a Long beyond 2^53 → string.
 *  - `encodeMongoValue` restores native types by path. On update the row's own
 *    document is the template — a path inherits the type it already holds, even
 *    if the schema never saw it. On insert the recorded type histogram is.
 *  - `encodeSqlValues` applies the column rules: exact numerics travel as
 *    strings, MySQL JSON columns get an explicit JSON parameter, `tinyint(1)`
 *    takes 0/1, and an empty string for a non-text column is NULL.
 *
 * The round trip this protects: for every document `d` read from the source,
 * `encode(decode(d), d)` equals `d` at the BSON or SQL type level.
 */

import type { SourceColumn, SourcePath, SourceSchema } from '@innolope/db'
import { bsonTypeOf, soleType } from './source-schema.js'

type Bson = typeof import('mongodb')

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────

/**
 * Make a driver value JSON-exact. Decimal128 becomes its decimal string and a
 * Long outside the safe-integer range becomes its digit string; a Long that fits
 * stays a plain number, which is what the driver has always returned for it.
 * Everything else (ObjectId, Date, Binary) already serialises to a faithful
 * string and is left for the encoder's template to restore.
 */
export function decodeMongoValue(value: unknown): unknown {
	if (value === null || value === undefined) return value
	if (Array.isArray(value)) return value.map(decodeMongoValue)
	const bsontype = (value as { _bsontype?: string })._bsontype
	if (bsontype === 'Decimal128') return (value as { toString(): string }).toString()
	if (bsontype === 'Long') {
		const long = value as { toNumber(): number; toString(): string }
		const asNumber = long.toNumber()
		return Number.isSafeInteger(asNumber) ? asNumber : long.toString()
	}
	if (typeof value === 'bigint') {
		return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value)) out[key] = decodeMongoValue(item)
		return out
	}
	return value
}

/** A path's single recorded BSON type, keyed for lookup by `encodeMongoValue`. */
export function mongoPathTypes(
	schema: SourceSchema | null | undefined,
): Map<string, string | null> {
	const types = new Map<string, string | null>()
	for (const path of schema?.paths ?? []) types.set(path.path, soleType(path))
	return types
}

/** Paths holding more than one BSON type in the recorded sample. */
export function mixedMongoPaths(schema: SourceSchema | null | undefined): SourcePath[] {
	return (schema?.paths ?? []).filter((path) => path.mixed)
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i
const INTEGER_RE = /^-?\d+$/
const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

function toDate(value: unknown): Date | null {
	if (value instanceof Date) return value
	if (typeof value !== 'string' && typeof value !== 'number') return null
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Restore the native type of one value from a template — the value the source
 * row holds at the same path — or, without one, the recorded schema type.
 * Values that do not fit the expected type are left alone rather than forced.
 */
export function encodeMongoValue(
	bson: Bson,
	value: unknown,
	ctx: { template?: unknown; path: string; types: Map<string, string | null> },
): unknown {
	if (value === null || value === undefined) return value
	// The cache's copy of a Decimal128, whatever the template says.
	if (isPlainObject(value) && Object.keys(value).length === 1 && '$numberDecimal' in value) {
		return bson.Decimal128.fromString(String(value.$numberDecimal))
	}
	const expected =
		ctx.template !== undefined && ctx.template !== null
			? bsonTypeOf(ctx.template)
			: (ctx.types.get(ctx.path) ?? null)

	switch (expected) {
		case 'objectId':
			return typeof value === 'string' && OBJECT_ID_RE.test(value)
				? new bson.ObjectId(value)
				: value
		case 'date':
			return typeof value === 'string' || typeof value === 'number'
				? (toDate(value) ?? value)
				: value
		case 'decimal128':
			if (typeof value === 'number' && Number.isFinite(value))
				return bson.Decimal128.fromString(String(value))
			return typeof value === 'string' && DECIMAL_RE.test(value.trim())
				? bson.Decimal128.fromString(value.trim())
				: value
		case 'long':
			if (typeof value === 'number' && Number.isInteger(value)) return bson.Long.fromNumber(value)
			return typeof value === 'string' && INTEGER_RE.test(value.trim())
				? bson.Long.fromString(value.trim())
				: value
		case 'number':
			return typeof value === 'string' && DECIMAL_RE.test(value.trim()) ? Number(value) : value
	}

	if (Array.isArray(value)) {
		const template = Array.isArray(ctx.template) ? ctx.template : undefined
		return value.map((item, index) =>
			encodeMongoValue(bson, item, {
				// The element at the same index, else any element: arrays are uniform
				// far more often than not, and the schema covers the rest.
				template: template ? (template[index] ?? template[0]) : undefined,
				path: `${ctx.path}[]`,
				types: ctx.types,
			}),
		)
	}
	if (isPlainObject(value)) {
		const template = isPlainObject(ctx.template) ? ctx.template : undefined
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value)) {
			out[key] = encodeMongoValue(bson, item, {
				template: template?.[key],
				path: `${ctx.path}.${key}`,
				types: ctx.types,
			})
		}
		return out
	}
	return value
}

/** The value a dotted patch path points at in the source row. */
function valueAtPath(doc: unknown, path: string): unknown {
	let node = doc
	for (const segment of path.split('.')) {
		if (!isPlainObject(node)) return undefined
		node = node[segment]
	}
	return node
}

/**
 * Encode a MongoDB `$set` patch (keys may be dotted paths) against the row's
 * current document. Top-level keys listed in `raw` are written exactly as given
 * — an opaque value an admin edited as JSON.
 */
export function encodeMongoPatch(
	bson: Bson,
	patch: Record<string, unknown>,
	opts: {
		existing?: Record<string, unknown> | null
		schema?: SourceSchema | null
		raw?: Set<string>
	},
): Record<string, unknown> {
	const types = mongoPathTypes(opts.schema)
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(patch)) {
		if (opts.raw?.has(key.split('.')[0])) {
			out[key] = value
			continue
		}
		out[key] = encodeMongoValue(bson, value, {
			template: opts.existing ? valueAtPath(opts.existing, key) : undefined,
			path: key,
			types,
		})
	}
	return out
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

const EXACT_NUMERIC = /^(numeric|decimal|bigint|int8|money)$/i

/**
 * Whether a SQL column holds text and can therefore store an empty string.
 * Everything else — numbers, dates, uuids, enums, JSON — reads `''` as NULL.
 */
export function isTextColumn(column: SourceColumn): boolean {
	return /char|text/i.test(column.nativeType)
}

function isJsonColumn(column: SourceColumn): boolean {
	return /^jsonb?$/i.test(column.nativeType)
}

function isBooleanTinyint(column: SourceColumn): boolean {
	return /^tinyint\(1\)/i.test(column.udtName ?? '')
}

/**
 * Apply the per-column write rules to a row of SQL values. Keys with no column
 * in the schema pass through untouched; the preflight decides what to do with
 * them.
 */
export function encodeSqlValues(
	values: Record<string, unknown>,
	schema: SourceSchema,
): Record<string, unknown> {
	const columns = new Map((schema.columns ?? []).map((column) => [column.name, column]))
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(values)) {
		const column = columns.get(key)
		out[key] = column ? encodeSqlValue(value, column, schema.dialect) : value
	}
	return out
}

export function encodeSqlValue(
	value: unknown,
	column: SourceColumn,
	dialect: SourceSchema['dialect'],
): unknown {
	if (value === undefined || value === null) return value
	if (value === '' && !isTextColumn(column)) return null
	if (isJsonColumn(column)) {
		// postgres-js serialises objects and arrays for a json/jsonb parameter on
		// its own (a pre-stringified value would be stored as a JSON string). The
		// MySQL driver does not, so the document is sent as JSON text.
		return dialect === 'mysql' ? JSON.stringify(value) : value
	}
	if (isBooleanTinyint(column) && typeof value === 'boolean') return value ? 1 : 0
	if (EXACT_NUMERIC.test(column.udtName ?? '') || EXACT_NUMERIC.test(column.nativeType)) {
		// Exact numerics travel as their digit string; a JS float would round them.
		if (typeof value === 'number' && Number.isFinite(value)) return String(value)
		if (typeof value === 'bigint') return value.toString()
	}
	return value
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export interface PreflightIssue {
	field: string
	reason: 'required' | 'enum' | 'tooLong' | 'generated' | 'mixed'
	message: string
}

/**
 * Check a SQL write against the recorded columns before the source is touched.
 * Returns the values to send (unknown and generated columns removed) and the
 * problems that would make the write fail.
 *
 * `mode: 'insert'` additionally requires every NOT NULL column without a
 * default; an update only refuses setting such a column to NULL.
 */
export function preflightSql(
	values: Record<string, unknown>,
	schema: SourceSchema,
	opts: { mode: 'insert' | 'update'; label?: (column: string) => string },
): { values: Record<string, unknown>; issues: PreflightIssue[] } {
	const label = opts.label ?? ((column: string) => column)
	const columns = new Map((schema.columns ?? []).map((column) => [column.name, column]))
	const out: Record<string, unknown> = {}
	const issues: PreflightIssue[] = []

	for (const [key, value] of Object.entries(values)) {
		const column = columns.get(key)
		// A key the table has no column for would fail the whole statement.
		if (!column) continue
		if (column.isGenerated) continue
		if (value === null && !column.nullable) {
			if (opts.mode === 'insert' && column.hasDefault) continue
			issues.push({
				field: key,
				reason: 'required',
				message: `${label(key)} is required by the source database.`,
			})
			continue
		}
		if (
			typeof value === 'string' &&
			column.enumValues?.length &&
			!column.enumValues.includes(value)
		) {
			issues.push({
				field: key,
				reason: 'enum',
				message: `${label(key)} must be one of: ${column.enumValues.join(', ')}.`,
			})
			continue
		}
		if (typeof value === 'string' && column.maxLength && [...value].length > column.maxLength) {
			issues.push({
				field: key,
				reason: 'tooLong',
				message: `${label(key)} is longer than the ${column.maxLength} characters the source column allows.`,
			})
			continue
		}
		out[key] = value
	}

	if (opts.mode === 'insert') {
		for (const column of columns.values()) {
			if (column.nullable || column.hasDefault || column.isGenerated || column.isIdentity) continue
			if (out[column.name] !== undefined && out[column.name] !== null) continue
			if (issues.some((issue) => issue.field === column.name)) continue
			issues.push({
				field: column.name,
				reason: 'required',
				message: `${label(column.name)} is required by the source database.`,
			})
		}
	}
	return { values: out, issues }
}

/**
 * Refuse a MongoDB write to a top-level field whose sampled documents disagree
 * on its type, unless the field is opaque (edited as JSON, written exactly as
 * entered). The editor cannot know which shape a given document expects, and
 * guessing is how a field ends up holding two types. Mixed types deeper down
 * need no refusal: the row's own document is the encoder's template there.
 */
export function preflightMongo(
	patch: Record<string, unknown>,
	schema: SourceSchema | null | undefined,
	opts: { opaque: Set<string>; label?: (column: string) => string },
): PreflightIssue[] {
	const label = opts.label ?? ((column: string) => column)
	const mixed = new Set(
		mixedMongoPaths(schema)
			.map((path) => path.path)
			.filter((path) => !path.includes('.') && !path.includes('[')),
	)
	const issues: PreflightIssue[] = []
	const seen = new Set<string>()
	for (const key of Object.keys(patch)) {
		const top = key.split('.')[0]
		if (seen.has(top) || opts.opaque.has(top) || !mixed.has(top)) continue
		seen.add(top)
		issues.push({
			field: top,
			reason: 'mixed',
			message: `${label(top)} holds different kinds of values across records; edit it as JSON under Technical fields.`,
		})
	}
	return issues
}
