import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'
import { users } from './users.js'

export const media = pgTable('media', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	type: text({ enum: ['image', 'video', 'file'] }).notNull(),
	filename: text().notNull(),
	mimeType: text().notNull(),
	size: integer().notNull(),
	url: text().notNull(),
	alt: text(),
	adapter: text().notNull().default('local'),
	externalId: text(),
	metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	createdBy: uuid().references(() => users.id),
}, (table) => [
	index('media_project_type_idx').on(table.projectId, table.type),
])
