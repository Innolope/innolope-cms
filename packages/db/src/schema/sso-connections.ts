import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const ssoConnections = pgTable(
	'sso_connections',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		protocol: text({ enum: ['saml', 'oidc'] }).notNull(),
		name: text().notNull(),
		slug: text().notNull(),
		enabled: boolean().notNull().default(false),
		enforceSso: boolean().notNull().default(false),
		allowIdpInitiated: boolean().notNull().default(false),
		domains: text().array().notNull().default([] as unknown as string[]),
		// OIDC
		oidcIssuer: text(),
		oidcClientId: text(),
		oidcClientSecretEnc: text(),
		oidcScopes: text().array().notNull().default(['openid', 'email', 'profile'] as unknown as string[]),
		// SAML
		samlEntityId: text(),
		samlSsoUrl: text(),
		samlIdpCertPems: text().array().notNull().default([] as unknown as string[]),
		samlWantAssertionsSigned: boolean().notNull().default(true),
		samlWantAssertionsEncrypted: boolean().notNull().default(false),
		// Attribute mapping
		attrEmail: text().notNull().default('email'),
		attrName: text().notNull().default('name'),
		attrGroups: text().notNull().default('groups'),
		defaultRole: text({ enum: ['admin', 'editor', 'viewer'] }).notNull().default('viewer'),
		groupRoleMap: jsonb().$type<Record<string, 'admin' | 'editor' | 'viewer'>>().notNull().default({}),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('sso_connections_project_slug_idx').on(table.projectId, table.slug),
		index('sso_connections_project_idx').on(table.projectId),
	],
)
