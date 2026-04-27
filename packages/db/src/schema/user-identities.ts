import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { ssoConnections } from './sso-connections.js'

export const userIdentities = pgTable(
	'user_identities',
	{
		id: uuid().defaultRandom().primaryKey(),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		connectionId: uuid()
			.notNull()
			.references(() => ssoConnections.id, { onDelete: 'cascade' }),
		provider: text({ enum: ['saml', 'oidc'] }).notNull(),
		subject: text().notNull(),
		email: text(),
		rawProfile: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		lastLoginAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('user_identities_conn_subject_idx').on(table.connectionId, table.subject),
		index('user_identities_user_idx').on(table.userId),
	],
)
