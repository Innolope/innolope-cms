import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { ssoConnections } from './sso-connections.js'

export const ssoAuthStates = pgTable(
	'sso_auth_states',
	{
		id: uuid().defaultRandom().primaryKey(),
		state: text().notNull().unique(),
		connectionId: uuid()
			.notNull()
			.references(() => ssoConnections.id, { onDelete: 'cascade' }),
		// OIDC: PKCE code_verifier; SAML: AuthnRequest ID (InResponseTo expected value)
		verifier: text().notNull(),
		nonce: text(),
		next: text(),
		// When 'link', complete by attaching identity to linkUserId instead of logging in
		intent: text({ enum: ['login', 'link', 'test'] }).notNull().default('login'),
		linkUserId: uuid(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('sso_auth_states_expires_idx').on(table.expiresAt)],
)
