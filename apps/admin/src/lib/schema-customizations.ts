import { type CollectionField, hasFieldCustomizations } from '@innolope/config'

/** A field a re-sync will drop, because the fresh scan no longer sees its column. */
export interface DroppedField {
	name: string
	/** Whether it carried schema-editor configuration that goes with it. */
	configured: boolean
}

/**
 * Find the fields a re-sync would delete outright.
 *
 * A re-sync rebuilds `collections.fields` from the scan, but the API re-applies
 * each field's schema-editor configuration by name (see
 * `mergeFieldCustomizations`), so labels, widgets, required ticks and the rest
 * survive. The one thing it cannot carry is a field whose column is gone from
 * the source: there is nothing to re-apply it to, so the field and its settings
 * disappear together. That is the case worth stopping to confirm.
 *
 * Note for MongoDB: `detectedColumns` comes from sampled documents, so a field
 * that exists in the data but not in the sample shows up here. That is a reason
 * to ask rather than a reason to distrust the check — the re-sync really would
 * drop it.
 */
export function detectDroppedFields(
	fields: CollectionField[] | undefined,
	detectedColumns: string[],
): DroppedField[] {
	const columnSet = new Set(detectedColumns)
	return (fields ?? [])
		.filter((field) => !columnSet.has(field.name))
		.map((field) => ({ name: field.name, configured: hasFieldCustomizations(field) }))
}
