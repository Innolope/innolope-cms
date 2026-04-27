import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { ssoConnections } from './sso-connections.js'
import { users } from './users.js'

export const scimTokens = pgTable(
	'scim_tokens',
	{
		id: uuid().defaultRandom().primaryKey(),
		connectionId: uuid()
			.notNull()
			.references(() => ssoConnections.id, { onDelete: 'cascade' }),
		name: text().notNull(),
		tokenHash: text().notNull().unique(),
		tokenPrefix: text().notNull(),
		createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		revokedAt: timestamp({ withTimezone: true }),
		lastUsedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('scim_tokens_conn_idx').on(table.connectionId)],
)
