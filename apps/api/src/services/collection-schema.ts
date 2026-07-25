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

import { type CollectionField, hasFieldCustomizations } from '@innolope/config'
import { buildSubField, type ObjectArrayShape } from '../adapters/mongo-introspect.js'
import { mapColumnType } from '../adapters/type-mapper.js'

/** A column as it arrives from a scan. */
export interface DetectedColumn {
	name: string
	type: string
	relationTo?: string
	relationIsArray?: boolean
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
	} = {},
): CollectionField[] {
	return columns
		.filter((c) => !EXCLUDED_COLUMNS.has(c.name))
		.map((c) => {
			const isSystem = SYSTEM_FIELDS.has(c.name)
			// A locale map (`{ en, uk }`) classifies as `object` from its runtime
			// shape alone. It isn't one — it's translatable text, and calling it text
			// is what makes the editor render per-locale inputs and what tells a write
			// to target one language instead of the whole map.
			const isLocalized = opts.localizedFields?.has(c.name) === true
			const resolvedType = (
				isLocalized ? 'text' : FIELD_TYPES.has(c.type) ? c.type : mapColumnType(c.type)
			) as CollectionField['type']

			// Read-only (system fields) and subFields (array-of-object shape) coexist
			// when both apply; the spread keeps the field shape compact when neither does.
			let ui: CollectionField['ui'] | undefined
			if (isSystem) ui = { ...(ui ?? {}), readOnly: true }
			const shape = resolvedType === 'array' ? opts.arrayShapes?.get(c.name) : undefined
			if (shape && shape.keys.length > 0) {
				ui = { ...(ui ?? {}), subFields: shape.keys.map((key) => buildSubField(key, shape)) }
			}

			return {
				name: c.name,
				type: resolvedType,
				required: false,
				localized: isLocalized,
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
