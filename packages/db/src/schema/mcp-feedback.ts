import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

/**
 * Agent feedback drop box: AI agents (via the MCP `report_feedback` tool) file
 * bug reports, friction notes, and improvement suggestions here so field
 * observations survive the session instead of evaporating with it.
 */
export const mcpFeedback = pgTable(
	'mcp_feedback',
	{
		id: uuid().defaultRandom().primaryKey(),
		// Null when no project was active (e.g. feedback about project discovery).
		projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
		// Reporter. Not a foreign key (mirrors audit_logs): feedback outlives its author.
		userId: uuid(),
		type: text({ enum: ['bug', 'suggestion', 'friction'] }).notNull(),
		// MCP tool the feedback concerns, when it is about a specific one.
		tool: text(),
		summary: text().notNull(),
		details: text(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('mcp_feedback_created_idx').on(table.createdAt)],
)
