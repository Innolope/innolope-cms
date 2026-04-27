import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
	id: uuid().defaultRandom().primaryKey(),
	email: text().notNull().unique(),
	name: text().notNull(),
	passwordHash: text(),
	role: text({ enum: ['admin', 'editor', 'viewer'] })
		.notNull()
		.default('editor'),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
})
