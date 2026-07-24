import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'
import { users } from './users.js'

/**
 * A project's OAuth connection to the user's own Cloudflare account.
 *
 * Tokens live here — encrypted, in their own table — rather than in
 * `project.settings`, so they can never leak through project serialization and
 * token refreshes don't race settings updates. Non-secret discovery results
 * (account id, Images delivery hash) are mirrored into `settings.cloudflare`
 * where the media adapter already reads them.
 */
export const cloudflareConnections = pgTable('cloudflare_connections', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.unique()
		.references(() => projects.id, { onDelete: 'cascade' }),
	accountId: text(),
	accountName: text(),
	/** AES-256-GCM via lib/crypto — never stored or serialized in plaintext. */
	accessTokenEnc: text().notNull(),
	refreshTokenEnc: text(),
	accessTokenExpiresAt: timestamp({ withTimezone: true }),
	scopes: text().array(),
	status: text({ enum: ['pending_account', 'active', 'needs_reconnect'] }).notNull(),
	connectedByUserId: uuid().references(() => users.id),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
})

/**
 * Single-use CSRF/PKCE state for the Cloudflare OAuth authorization flow,
 * mirroring `sso_auth_states`: the callback arrives as a top-level cross-site
 * redirect with no usable cookies, so all context is bound to this row.
 */
export const cloudflareOauthStates = pgTable(
	'cloudflare_oauth_states',
	{
		id: uuid().defaultRandom().primaryKey(),
		state: text().notNull().unique(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** PKCE code_verifier. */
		verifier: text().notNull(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('cloudflare_oauth_states_expires_idx').on(table.expiresAt)],
)
