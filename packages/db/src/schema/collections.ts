import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const collections = pgTable('collections', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	name: text().notNull(),
	slug: text().notNull(),
	description: text(),
	fields: jsonb().$type<CollectionField[]>().notNull().default([]),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('collections_slug_project_idx').on(table.slug, table.projectId),
])

export interface CollectionField {
	name: string
	type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'relation' | 'json'
	required?: boolean
	localized?: boolean
	options?: string[]
	defaultValue?: unknown
}
