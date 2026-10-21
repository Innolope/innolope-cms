/**
 * Building a collection's field schema from a database scan, and carrying a
 * human's edits across a re-sync.
 *
 * The import wizard rebuilds `collections.fields` from scratch every time it
 * runs, which is what lets a re-sync upgrade types (text → date/relation) and
 * pick up newly translatable fields. On its own that also throws away everything
 * an editor configured in the schema editor, so `mergeFieldCustomizations`
 * re-applies the properties detection cannot produce and reports the few it
 * genuinely cannot carry.
 */

import { type CollectionField, detectFieldPreset, hasFieldCustomizations } from '@innolope/config'
import type { SourceColumn, SourceSchema } from '@innolope/db'
import { buildSubField, type ObjectArrayShape } from '../adapters/mongo-introspect.js'
import { soleType } from '../adapters/source-schema.js'
import { mapColumnType } from '../adapters/type-mapper.js'

/** A column as it arrives from a scan. */
export interface DetectedColumn {
	name: string
	type: string
	relationTo?: string
	relationIsArray?: boolean
	/**
	 * A `text` column whose every sampled value was a full ISO-8601 timestamp.
	 * The type stays `text` so writes keep storing strings; this only upgrades the
	 * editor's widget from a raw input to a datetime picker.
	 */
	isIsoDate?: boolean
}

const FIELD_TYPES = new Set([
	'text',
	'number',
	'boolean',
	'date',
	'enum',
	'relation',
	'object',
	'array',
])

/** Columns that never become schema fields. */
const EXCLUDED_COLUMNS = new Set([
	'_id',
	'id',
	// `slug` is already represented at the top level of every content row as
	// `content.slug`, and the editor renders a dedicated slug input. Letting it
	// through as a schema field produced a duplicate input AND a duplicate value
	// in the saved payload (top-level + metadata.slug).
	'slug',
])

/** Database-owned columns the editor should not offer for editing. */
const SYSTEM_FIELDS = new Set(['__v'])

/**
 * Map scanned columns to collection fields.
 *
 * MongoDB scan columns already carry a resolved CollectionField type; SQL
 * columns carry a raw data_type string. Only genuinely database-owned columns
 * are marked read-only — lifecycle timestamps (createdAt/updatedAt/publishedAt)
 * are deliberately NOT: editors routinely need to backdate a post, and the site
 * consuming the source database usually renders `createdAt` as the published
 * date. They stay ordinary editable `date` fields; an admin who wants one locked
 * can tick Advanced → Read-only in the collection schema editor.
 */
export function buildCollectionFields(
	columns: DetectedColumn[],
	opts: {
		/** Array-of-object shapes for this table, keyed by column name. */
		arrayShapes?: Map<string, ObjectArrayShape>
		/** Columns this table stores as `{ <locale>: string }` maps. */
		localizedFields?: Set<string>
		/**
		 * The table's recorded shape. SQL columns refine the type (a native enum
		 * becomes a dropdown, `tinyint(1)` a checkbox, a generated column read-only);
		 * a MongoDB path with mixed types becomes an opaque field.
		 */
		sourceSchema?: SourceSchema | null
	} = {},
): CollectionField[] {
	const sourceColumns = new Map<string, SourceColumn>(
		(opts.sourceSchema?.columns ?? []).map((column) => [column.name, column]),
	)
	const mixedPaths = new Set(
		(opts.sourceSchema?.paths ?? []).filter((path) => path.mixed).map((path) => path.path),
	)
	return columns
		.filter((c) => !EXCLUDED_COLUMNS.has(c.name))
		.map((c) => {
			const isSystem = SYSTEM_FIELDS.has(c.name)
			// A locale map (`{ en, uk }`) classifies as `object` from its runtime
			// shape alone. It isn't one — it's translatable text, and calling it text
			// is what makes the editor render per-locale inputs and what tells a write
			// to target one language instead of the whole map.
			const isLocalized = opts.localizedFields?.has(c.name) === true
			const source = sourceColumns.get(c.name)
			let resolvedType = (
				isLocalized ? 'text' : FIELD_TYPES.has(c.type) ? c.type : mapColumnType(c.type)
			) as CollectionField['type']
			let options: string[] | undefined
			if (source && !isLocalized) {
				if (source.enumValues?.length) {
					resolvedType = 'enum'
					options = source.enumValues
				} else if (/^tinyint\(1\)/i.test(source.udtName ?? '')) {
					resolvedType = 'boolean'
				}
			}
			const opaque = mixedPaths.has(c.name)

			// Read-only (system fields) and subFields (array-of-object shape) coexist
			// when both apply; the spread keeps the field shape compact when neither does.
			let ui: CollectionField['ui'] | undefined
			if (isSystem || source?.isGenerated) ui = { ...(ui ?? {}), readOnly: true }
			// Documents disagree on this field's type: it round-trips untouched and is
			// written only when an admin edits it as JSON.
			if (opaque) ui = { ...(ui ?? {}), opaque: true }
			const shape = resolvedType === 'array' ? opts.arrayShapes?.get(c.name) : undefined
			if (shape && shape.keys.length > 0) {
				ui = { ...(ui ?? {}), subFields: shape.keys.map((key) => buildSubField(key, shape)) }
			}
			// A column the source stores as an ISO string is a date to the editor and a
			// string to the database. Detection can't make it `type: 'date'` without
			// changing what gets written back, so the widget carries the intent instead.
			if (c.isIsoDate && resolvedType === 'text' && !isLocalized) {
				ui = { ...(ui ?? {}), widget: 'datetime' }
			}

			return {
				name: c.name,
				type: resolvedType,
				required: false,
				localized: isLocalized,
				...(options && { options }),
				...(c.relationTo && { relationTo: c.relationTo }),
				...(c.relationIsArray && { relationIsArray: true }),
				...(ui && { ui }),
			}
		})
}

/** A hand-made edit a re-sync cannot carry over. */
export interface UnpreservedFieldChange {
	field: string
	/** `removed`: the source no longer has this column. `typeChanged`: detection disagrees. */
	kind: 'removed' | 'typeChanged'
	from?: string
	to?: string
}

/**
 * Re-apply a collection's hand-made field configuration on top of a freshly
 * detected schema.
 *
 * Everything detection cannot produce — labels, required ticks, default values,
 * widget and help-text overrides — is carried across by field name, so a
 * re-sync upgrades types and localization flags without resetting anyone's
 * schema editor work.
 *
 * Two things cannot be carried, and are returned for the caller to surface:
 *  - a configured field whose type detection now disagrees about (there is no
 *    provenance on `type`, so preferring the stored one would defeat the point
 *    of re-syncing — which exists to upgrade text → date/relation),
 *  - a field the scan no longer sees at all, which drops out of the schema.
 *
 * Only *configured* fields produce a `typeChanged` entry. A pristine detected
 * field changing type is detection doing its job, and warning about it would
 * bury the reports that matter in noise.
 */
export function mergeFieldCustomizations(
	previous: CollectionField[] | undefined,
	detected: CollectionField[],
): { fields: CollectionField[]; unpreserved: UnpreservedFieldChange[] } {
	const previousByName = new Map((previous ?? []).map((f) => [f.name, f]))
	const detectedNames = new Set(detected.map((f) => f.name))
	const unpreserved: UnpreservedFieldChange[] = []

	const fields = detected.map((field) => {
		const prior = previousByName.get(field.name)
		if (!prior) return field

		if (prior.type !== field.type && hasFieldCustomizations(prior)) {
			unpreserved.push({
				field: field.name,
				kind: 'typeChanged',
				from: prior.type,
				to: field.type,
			})
		}

		const ui: CollectionField['ui'] = { ...prior.ui, ...field.ui }
		// Shape detection is authoritative when it found something; when it found
		// nothing (no sampled rows), the previously recorded shape is better than
		// dropping to a generic widget.
		if (!field.ui?.subFields && prior.ui?.subFields) ui.subFields = prior.ui.subFields
		// A preset an admin confirmed in the field designer outranks detection, and
		// so does any earlier preset when this sample found none.
		if (prior.ui?.presetConfirmed || (!field.ui?.preset && prior.ui?.preset)) {
			ui.preset = prior.ui?.preset
			ui.presetKeys = prior.ui?.presetKeys
			if (!ui.presetKeys) delete ui.presetKeys
		}

		return {
			...field,
			...(prior.label && { label: prior.label }),
			...(prior.required && { required: true }),
			...(prior.defaultValue !== undefined && { defaultValue: prior.defaultValue }),
			// Enum options are re-detected asynchronously by the import worker;
			// carrying them keeps the field usable in the window before that lands.
			...(!field.options?.length && prior.options?.length && { options: prior.options }),
			...(Object.keys(ui).length > 0 && { ui }),
		}
	})

	for (const prior of previous ?? []) {
		if (!detectedNames.has(prior.name)) {
			unpreserved.push({ field: prior.name, kind: 'removed' })
		}
	}

	return { fields, unpreserved }
}

/**
 * Scan columns for a MongoDB descriptor: one per top-level path, typed from the
 * BSON types the sample holds there. Relation targets are not re-resolved here
 * (that needs a probe of every collection); `carryRelationTargets` restores the
 * ones the previous schema already knew.
 */
export function detectedColumnsFromMongoSchema(schema: SourceSchema): DetectedColumn[] {
	const paths = new Map((schema.paths ?? []).map((path) => [path.path, path]))
	const columns: DetectedColumn[] = []
	for (const path of schema.paths ?? []) {
		if (path.path.includes('.') || path.path.includes('[')) continue
		const type = path.mixed ? 'object' : soleType(path)
		if (!type || type === 'null') continue
		const element = soleType(paths.get(`${path.path}[]`))
		columns.push({
			name: path.path,
			type:
				type === 'objectId'
					? 'relation'
					: type === 'array' && element === 'objectId'
						? 'relation'
						: (MONGO_TYPE_TO_FIELD[type] ?? 'text'),
			...(type === 'array' && element === 'objectId' && { relationIsArray: true }),
		})
	}
	return columns
}

const MONGO_TYPE_TO_FIELD: Record<string, string> = {
	string: 'text',
	number: 'number',
	long: 'number',
	decimal128: 'number',
	bool: 'boolean',
	date: 'date',
	object: 'object',
	array: 'array',
	binary: 'text',
	timestamp: 'date',
}

/** Locale-map fields and array-of-object shapes, read off a MongoDB histogram. */
export function mongoShapesFromSchema(schema: SourceSchema): {
	localizedFields: Set<string>
	arrayShapes: Map<string, ObjectArrayShape>
} {
	const localizedFields = new Set<string>()
	const arrayShapes = new Map<string, ObjectArrayShape>()
	const children = new Map<string, Array<{ key: string; types: string[] }>>()
	for (const path of schema.paths ?? []) {
		const match = /^(.+?)(\[\])?\.([^.[\]]+)$/.exec(path.path)
		if (!match || match[1].includes('.') || match[1].includes('[')) continue
		const parent = `${match[1]}${match[2] ?? ''}`
		const list = children.get(parent) ?? []
		list.push({ key: match[3], types: Object.keys(path.types).filter((t) => t !== 'null') })
		children.set(parent, list)
	}
	for (const [parent, keys] of children) {
		if (parent.endsWith('[]')) {
			arrayShapes.set(parent.slice(0, -2), {
				keys: keys.map((k) => k.key),
				stringValues: new Map(),
			})
		} else if (
			keys.length > 0 &&
			keys.every(
				(k) => /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(k.key) && k.types.every((t) => t === 'string'),
			)
		) {
			localizedFields.add(parent)
		}
	}
	return { localizedFields, arrayShapes }
}

/**
 * Keep what a MongoDB re-scan cannot re-derive from a sample: relation targets
 * (resolved by probing other collections) and recorded row shapes, which carry
 * enum options the histogram has no values for.
 */
export function carryMongoDetections(
	previous: CollectionField[] | undefined,
	fields: CollectionField[],
): CollectionField[] {
	const prior = new Map((previous ?? []).map((field) => [field.name, field]))
	return fields.map((field) => {
		const before = prior.get(field.name)
		if (!before) return field
		const next = { ...field }
		if (field.type === 'relation' && before.relationTo && !field.relationTo) {
			next.relationTo = before.relationTo
		}
		if (before.ui?.subFields?.length) next.ui = { ...next.ui, subFields: before.ui.subFields }
		return next
	})
}

/**
 * Refine detected fields with a sample of real rows.
 *
 *  - A JSON column whose values are arrays is an `array`, not an `object` — the
 *    type mapper only sees `json`/`jsonb`, and an `object` type made validation
 *    refuse every edit to it.
 *  - A field whose sampled values agree on a shape preset gets `ui.preset` and the
 *    document's own key names in `ui.presetKeys`. A text field only ever becomes
 *    an image (a URL pointing at one). A preset an admin confirmed is left alone.
 */
export function refineFieldsFromSamples(
	fields: CollectionField[],
	docs: Array<Record<string, unknown>>,
): CollectionField[] {
	if (docs.length === 0) return fields
	return fields.map((field) => {
		const values = docs.map((doc) => doc[field.name])
		const filled = values.filter((value) => value !== null && value !== undefined && value !== '')
		let next = field
		if (field.type === 'object' && filled.length > 0 && filled.every(Array.isArray)) {
			next = { ...next, type: 'array' }
		}
		if (next.localized || next.ui?.presetConfirmed || next.ui?.opaque) return next
		if (!['object', 'array', 'text'].includes(next.type)) return next
		const match = detectFieldPreset(values, next.type)
		if (!match) return next
		if (next.type === 'text' && match.preset !== 'image') return next
		return {
			...next,
			ui: {
				...next.ui,
				preset: match.preset,
				...(Object.keys(match.keys).length > 0 && { presetKeys: match.keys }),
			},
		}
	})
}
