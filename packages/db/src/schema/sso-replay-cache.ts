import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const ssoReplayCache = pgTable(
	'sso_replay_cache',
	{
		responseId: text().primaryKey(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('sso_replay_cache_expires_idx').on(table.expiresAt)],
)
