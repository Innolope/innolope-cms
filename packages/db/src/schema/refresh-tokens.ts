import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const refreshTokens = pgTable('refresh_tokens', {
	id: uuid().defaultRandom().primaryKey(),
	userId: uuid()
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	tokenHash: text().notNull().unique(),
	family: text().notNull(),
	expiresAt: timestamp({ withTimezone: true }).notNull(),
	revoked: boolean().notNull().default(false),
	authMethod: text({ enum: ['password', 'sso'] }).notNull().default('password'),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('refresh_tokens_user_idx').on(table.userId),
	index('refresh_tokens_family_idx').on(table.family),
])
