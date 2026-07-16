import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * Short-lived, single-use OAuth authorization codes (RFC 6749 §4.1) with PKCE
 * (RFC 7636). Only the SHA-256 hash of the code is stored. `consumedAt` marks a
 * code as spent so a replayed code is rejected.
 */
export const oauthAuthCodes = pgTable(
	'oauth_auth_codes',
	{
		id: uuid().defaultRandom().primaryKey(),
		codeHash: text().notNull().unique(),
		clientId: text().notNull(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		redirectUri: text().notNull(),
		codeChallenge: text().notNull(),
		codeChallengeMethod: text().notNull().default('S256'),
		scope: text(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		consumedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('oauth_auth_codes_user_idx').on(table.userId)],
)
