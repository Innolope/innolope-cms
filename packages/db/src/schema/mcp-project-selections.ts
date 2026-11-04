import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/** Last explicit MCP selection, shared only by the same user and OAuth client. */
export const mcpProjectSelections = pgTable(
	'mcp_project_selections',
	{
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		clientId: text().notNull().default(''),
		// Deleted projects are handled by checking current access at restore time.
		projectId: uuid().notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.clientId] })],
)
