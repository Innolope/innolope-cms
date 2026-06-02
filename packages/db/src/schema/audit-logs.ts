import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const auditLogs = pgTable(
	'audit_logs',
	{
		id: uuid().defaultRandom().primaryKey(),
		// Null for account-level actions that aren't scoped to a single project.
		projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
		// Actor. Intentionally NOT a foreign key and the email is denormalized so the
		// audit trail survives deletion of the user it refers to.
		userId: uuid(),
		userEmail: text(),
		action: text().notNull(),
		method: text().notNull(),
		path: text().notNull(),
		statusCode: integer().notNull(),
		resourceType: text(),
		resourceId: text(),
		ip: text(),
		userAgent: text(),
		details: jsonb().$type<Record<string, unknown>>(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('audit_logs_project_created_idx').on(table.projectId, table.createdAt)],
)
