import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'
import { users } from './users.js'

export const apiKeys = pgTable('api_keys', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	name: text().notNull(),
	keyHash: text().notNull().unique(),
	keyPrefix: text().notNull(),
	userId: uuid()
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	permissions: jsonb().$type<string[]>().notNull().default([]),
	expiresAt: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	lastUsedAt: timestamp({ withTimezone: true }),
}, (table) => [
	index('api_keys_project_idx').on(table.projectId),
])
