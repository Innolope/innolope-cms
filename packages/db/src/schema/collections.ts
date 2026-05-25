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
		source: text().notNull().default('internal'),
		externalTable: text(),
		accessMode: text().default('read-write'),
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
	type: 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'relation' | 'object' | 'array'
	required?: boolean
	localized?: boolean
	options?: string[]
	defaultValue?: unknown
	/** For `relation` fields on external collections: the external table this field references. */
	relationTo?: string
	/** Whether the relation field holds an array of references. */
	relationIsArray?: boolean
}
