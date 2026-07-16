import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * OAuth refresh tokens issued to MCP clients. Kept separate from the cookie-session
 * `refresh_tokens` table so the OAuth grant (with its own client + scope) never
 * entangles the human login rotation. Rotated single-use on each refresh; only the
 * SHA-256 hash is stored.
 */
export const oauthRefreshTokens = pgTable(
	'oauth_refresh_tokens',
	{
		id: uuid().defaultRandom().primaryKey(),
		tokenHash: text().notNull().unique(),
		clientId: text().notNull(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		scope: text(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		revoked: boolean().notNull().default(false),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('oauth_refresh_tokens_user_idx').on(table.userId)],
)
