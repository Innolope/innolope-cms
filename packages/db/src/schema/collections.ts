import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const collections = pgTable(
	'collections',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		label: text().notNull(),
		name: text().notNull(),
		description: text(),
		fields: jsonb().$type<CollectionField[]>().notNull().default([]),
		// Name of the schema field whose value is used as the record's display
		// label in list views and reference pickers. Null means use the smart
		// heuristic in `apps/admin/src/lib/display-title.ts`.
		titleField: text(),
		source: text().notNull().default('internal'),
		externalTable: text(),
		accessMode: text().default('read-write'),
		// Controls whether this collection appears in the admin sidebar.
		// `auto` = hide if referenced as a `relationTo` target from another collection in this project.
		// `show` / `hide` are explicit overrides.
		sidebarMode: text({ enum: ['auto', 'show', 'hide'] })
			.notNull()
			.default('auto'),
		// Wall-clock time the local cache was last refreshed from the source.
		lastSyncedAt: timestamp({ withTimezone: true }),
		// High-watermark of the source's cursor column at the end of the last sync;
		// the next incremental sync pulls only rows with cursorColumn > this value.
		lastSyncedCursor: timestamp({ withTimezone: true }),
		// Source-table column used as the incremental cursor (e.g. updated_at).
		// Null means incremental mode is unavailable for this collection.
		cursorColumn: text(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex('collections_name_project_idx').on(table.name, table.projectId)],
)

export interface CollectionField {
	name: string
	/** Optional human-readable label shown by the form instead of `name`. */
	label?: string
	type: 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'relation' | 'object' | 'array'
	required?: boolean
	localized?: boolean
	options?: string[]
	defaultValue?: unknown
	/** For `relation` fields on external collections: the external table this field references. */
	relationTo?: string
	/** Whether the relation field holds an array of references. */
	relationIsArray?: boolean
	/**
	 * Optional UI hints that override the default widget chosen from `type`.
	 * Stored alongside the field definition in the same JSONB blob so no
	 * separate migration is needed when adding new hints.
	 */
	ui?: CollectionFieldUi
}

export interface CollectionFieldUi {
	/**
	 * Widget identifier. Filtered by `type` at render time — see
	 * `apps/admin/src/components/editor/field-renderer.tsx` for the catalog
	 * and `defaultWidgetFor(field)` for the fallback.
	 */
	widget?: string
	placeholder?: string
	helpText?: string
	/** Number of visible rows when `widget === 'textarea'`. */
	rows?: number
	/** Chip-input separator. Defaults to 'enter'. */
	separator?: 'enter' | 'comma' | 'both'
	/** Render the field disabled — useful for system-managed values. */
	readOnly?: boolean
	/** Hide the field from edit forms entirely. */
	hidden?: boolean
	/** Structured sub-fields, used when `widget === 'subform'` on an object/array. */
	subFields?: CollectionField[]
}
