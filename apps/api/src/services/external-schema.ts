/**
 * Keeping a collection's field schema in step with its source table after the
 * import wizard has run.
 *
 * The wizard scans once. A column added, dropped or retyped afterwards used to
 * stay invisible until a write hit it and surfaced as a 502. Two mechanisms now
 * keep the two in step:
 *
 *  - `rescanExternalCollection` re-learns one table from the source, records its
 *    `sourceSchema`, and merges the fields through `mergeFieldCustomizations`,
 *    which keeps labels, widgets and required ticks. It runs after an
 *    unknown-column write error and when an admin reviews detected drift.
 *  - `checkSourceSchemaDrift` runs on the sync worker's pass and compares the
 *    recorded shape hash with a fresh description. A difference is recorded on
 *    `external_sync_state` and shown where sync conflicts appear; nothing about
 *    the editor changes until an admin reviews it.
 */

import type { CollectionField } from '@innolope/config'
import {
	collections,
	type Database,
	type ExternalSchemaDrift,
	externalSyncState,
	type SourceSchema,
} from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { ExternalDbAdapter } from '../adapters/external-db.js'
import {
	buildCollectionFields,
	carryMongoDetections,
	type DetectedColumn,
	detectedColumnsFromMongoSchema,
	mergeFieldCustomizations,
	mongoShapesFromSchema,
	refineFieldsFromSamples,
	type UnpreservedFieldChange,
} from './collection-schema.js'

type Collection = typeof collections.$inferSelect

/** Rows sampled to detect shape presets. */
export const PRESET_SAMPLE_SIZE = 20

/** How often the sync worker re-describes a table to look for drift. */
export const SCHEMA_CHECK_INTERVAL_MS = 5 * 60_000

/** Scan columns for a SQL descriptor, in the shape the wizard's scan produces. */
export function detectedColumnsFromSchema(schema: SourceSchema): DetectedColumn[] {
	if (schema.dialect === 'mongodb') return detectedColumnsFromMongoSchema(schema)
	return (schema.columns ?? []).map((column) => ({ name: column.name, type: column.nativeType }))
}

/** Fields for a freshly described table, merged with the collection's own edits. */
export function fieldsFromSourceSchema(
	previous: CollectionField[] | undefined,
	schema: SourceSchema,
	samples: Array<Record<string, unknown>> = [],
): { fields: CollectionField[]; unpreserved: UnpreservedFieldChange[] } {
	const shapes = schema.dialect === 'mongodb' ? mongoShapesFromSchema(schema) : undefined
	const detected = refineFieldsFromSamples(
		buildCollectionFields(detectedColumnsFromSchema(schema), {
			sourceSchema: schema,
			localizedFields: shapes?.localizedFields,
			arrayShapes: shapes?.arrayShapes,
		}),
		samples,
	)
	const merged = mergeFieldCustomizations(previous, detected)
	return {
		fields:
			schema.dialect === 'mongodb' ? carryMongoDetections(previous, merged.fields) : merged.fields,
		unpreserved: merged.unpreserved,
	}
}

/**
 * Re-learn a collection's fields from its source table and persist them with
 * the table's recorded shape. Returns the refreshed collection and the
 * customizations a type change or a dropped column could not carry over.
 */
export async function rescanExternalCollection(
	db: Pick<Database, 'update'>,
	col: Collection,
	adapter: ExternalDbAdapter,
): Promise<{ col: Collection; unpreserved: UnpreservedFieldChange[]; schema: SourceSchema }> {
	if (!col.externalTable) throw new Error('Collection has no external table')
	const schema = await adapter.describeTable(col.externalTable)
	const samples = await adapter.findAll(col.externalTable, { limit: PRESET_SAMPLE_SIZE })
	const { fields, unpreserved } = fieldsFromSourceSchema(
		col.fields as CollectionField[],
		schema,
		samples,
	)
	const [refreshed] = await db
		.update(collections)
		.set({ fields, sourceSchema: schema, sourceSchemaHash: schema.hash, updatedAt: new Date() })
		.where(eq(collections.id, col.id))
		.returning()
	await db
		.update(externalSyncState)
		.set({ schemaDrift: null, schemaCheckedAt: new Date() })
		.where(eq(externalSyncState.collectionId, col.id))
	return {
		col: refreshed ?? { ...col, fields, sourceSchema: schema, sourceSchemaHash: schema.hash },
		unpreserved,
		schema,
	}
}

function shapeEntries(schema: SourceSchema): Map<string, string> {
	const entries = new Map<string, string>()
	for (const column of schema.columns ?? []) {
		entries.set(
			column.name,
			JSON.stringify([
				column.nativeType,
				column.udtName,
				column.nullable,
				column.hasDefault,
				column.isGenerated,
				column.maxLength,
				column.enumValues,
			]),
		)
	}
	for (const path of schema.paths ?? []) {
		// Only top-level paths: nested shapes churn with the sample, and a change
		// inside an embedded document is reported as its top-level field.
		if (path.path.includes('.') || path.path.includes('[')) continue
		entries.set(path.path, JSON.stringify(Object.keys(path.types).sort()))
	}
	return entries
}

/** What changed between the recorded shape and a fresh one. */
export function diffSourceSchemas(
	recorded: SourceSchema,
	current: SourceSchema,
): Omit<ExternalSchemaDrift, 'detectedAt' | 'hash'> {
	const before = shapeEntries(recorded)
	const after = shapeEntries(current)
	const added = [...after.keys()].filter((key) => !before.has(key))
	const removed = [...before.keys()].filter((key) => !after.has(key))
	const changed = [...after.keys()].filter(
		(key) => before.has(key) && before.get(key) !== after.get(key),
	)
	return { added, removed, changed }
}

/**
 * Compare a collection's recorded source shape with the table as it is now.
 *
 * A collection imported before shapes were recorded gets its first descriptor
 * here, silently: there is nothing to compare against, and recording it is what
 * turns the type-preserving codec on for it. Its mixed-type MongoDB fields are
 * marked opaque at the same time, so the preflight that refuses guessing at
 * them always has the JSON editor to point to.
 */
export async function checkSourceSchemaDrift(
	db: Pick<Database, 'select' | 'update'>,
	col: Collection,
	adapter: ExternalDbAdapter,
	now = new Date(),
): Promise<ExternalSchemaDrift | null> {
	if (!col.externalTable) return null
	const [state] = await db
		.select({ schemaCheckedAt: externalSyncState.schemaCheckedAt })
		.from(externalSyncState)
		.where(eq(externalSyncState.collectionId, col.id))
		.limit(1)
	if (
		state?.schemaCheckedAt &&
		now.getTime() - state.schemaCheckedAt.getTime() < SCHEMA_CHECK_INTERVAL_MS
	) {
		return null
	}
	const current = await adapter.describeTable(col.externalTable)
	const recorded = col.sourceSchema

	if (!recorded) {
		const fields = markMixedFieldsOpaque(col.fields as CollectionField[], current)
		await db
			.update(collections)
			.set({ sourceSchema: current, sourceSchemaHash: current.hash, fields })
			.where(eq(collections.id, col.id))
		await db
			.update(externalSyncState)
			.set({ schemaCheckedAt: now, schemaDrift: null })
			.where(eq(externalSyncState.collectionId, col.id))
		return null
	}

	const diff = diffSourceSchemas(recorded, current)
	const drifted = diff.added.length + diff.removed.length + diff.changed.length > 0
	const drift: ExternalSchemaDrift | null = drifted
		? { ...diff, detectedAt: now.toISOString(), hash: current.hash }
		: null
	await db
		.update(externalSyncState)
		.set({ schemaCheckedAt: now, schemaDrift: drift })
		.where(eq(externalSyncState.collectionId, col.id))
	return drift
}

/** Mark top-level MongoDB fields whose sampled documents disagree on type. */
export function markMixedFieldsOpaque(
	fields: CollectionField[],
	schema: SourceSchema,
): CollectionField[] {
	const mixed = new Set(
		(schema.paths ?? [])
			.filter((path) => path.mixed && !path.path.includes('.') && !path.path.includes('['))
			.map((path) => path.path),
	)
	if (mixed.size === 0) return fields
	return fields.map((field) =>
		mixed.has(field.name) && !field.ui?.opaque
			? { ...field, ui: { ...field.ui, opaque: true } }
			: field,
	)
}
