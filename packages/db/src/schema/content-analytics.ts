import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'
import { content } from './content.js'

export const contentAnalytics = pgTable('content_analytics', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	contentId: uuid().references(() => content.id, { onDelete: 'set null' }),
	event: text({ enum: ['api_read', 'mcp_read', 'search_hit', 'search_miss'] }).notNull(),
	query: text(),
	source: text({ enum: ['api', 'mcp', 'sdk'] }).notNull(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('analytics_project_idx').on(table.projectId),
	index('analytics_project_event_idx').on(table.projectId, table.event),
	index('analytics_content_idx').on(table.contentId),
	index('analytics_created_idx').on(table.createdAt),
])
