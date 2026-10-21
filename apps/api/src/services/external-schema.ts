/**
 * Keeping a collection's field schema in step with its source table after the
 * import wizard has run.
 *
 * The wizard scans once. A column added, dropped or retyped afterwards used to
 * stay invisible until a write hit it and surfaced as a 502. `rescanExternalCollection`
 * re-learns one table from the source and merges the result through
 * `mergeFieldCustomizations`, which keeps labels, widgets and required ticks.
 */

import type { CollectionField } from '@innolope/config'
import { collections, type Database, type SourceSchema } from '@innolope/db'
import { eq } from 'drizzle-orm'
import type { ExternalDbAdapter } from '../adapters/external-db.js'
import {
	buildCollectionFields,
	type DetectedColumn,
	mergeFieldCustomizations,
	type UnpreservedFieldChange,
} from './collection-schema.js'

type Collection = typeof collections.$inferSelect

/** Scan columns for a SQL descriptor, in the shape the wizard's scan produces. */
export function detectedColumnsFromSchema(schema: SourceSchema): DetectedColumn[] {
	return (schema.columns ?? []).map((column) => ({ name: column.name, type: column.nativeType }))
}

/**
 * Re-learn a SQL collection's fields from its source table and persist them.
 * Returns the refreshed collection and the customizations a type change or a
 * dropped column could not carry over.
 */
export async function rescanExternalCollection(
	db: Pick<Database, 'update'>,
	col: Collection,
	adapter: ExternalDbAdapter,
): Promise<{ col: Collection; unpreserved: UnpreservedFieldChange[]; schema: SourceSchema }> {
	if (!col.externalTable) throw new Error('Collection has no external table')
	const schema = await adapter.describeTable(col.externalTable)
	if (schema.dialect === 'mongodb') {
		// MongoDB has no columns to drop; its drift is handled on the sync pass.
		return { col, unpreserved: [], schema }
	}
	const detected = buildCollectionFields(detectedColumnsFromSchema(schema))
	const { fields, unpreserved } = mergeFieldCustomizations(
		col.fields as CollectionField[],
		detected,
	)
	const [refreshed] = await db
		.update(collections)
		.set({ fields, updatedAt: new Date() })
		.where(eq(collections.id, col.id))
		.returning()
	return { col: refreshed ?? { ...col, fields }, unpreserved, schema }
}
