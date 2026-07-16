import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * OAuth 2.1 clients registered via Dynamic Client Registration (RFC 7591).
 * MCP clients self-register here before starting the authorization-code flow.
 * All clients are public (PKCE, no secret); `tokenEndpointAuthMethod` is 'none'.
 */
export const oauthClients = pgTable('oauth_clients', {
	id: uuid().defaultRandom().primaryKey(),
	clientId: text().notNull().unique(),
	clientName: text(),
	redirectUris: jsonb().$type<string[]>().notNull().default([]),
	grantTypes: jsonb().$type<string[]>().notNull().default(['authorization_code', 'refresh_token']),
	scope: text(),
	tokenEndpointAuthMethod: text().notNull().default('none'),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
})
