import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { collections } from './collections.js'
import { projects } from './projects.js'
import { users } from './users.js'

/**
 * A background job that fills the local `content` cache from an external
 * collection. While a job is `pending`/`running`, reads of its collection are
 * served live from the external DB so the full collection stays browsable.
 */
export const importJobs = pgTable(
	'import_jobs',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		collectionId: uuid()
			.notNull()
			.references(() => collections.id, { onDelete: 'cascade' }),
		externalTable: text().notNull(),
		status: text({ enum: ['pending', 'running', 'completed', 'failed'] })
			.notNull()
			.default('pending'),
		// Total external rows to import (null until the worker counts them).
		total: integer(),
		// Rows walked so far — also the resume offset if the worker restarts.
		processed: integer().notNull().default(0),
		error: text(),
		createdBy: uuid().references(() => users.id),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		startedAt: timestamp({ withTimezone: true }),
		completedAt: timestamp({ withTimezone: true }),
	},
	(table) => [
		index('import_jobs_status_idx').on(table.status),
		index('import_jobs_collection_idx').on(table.collectionId),
	],
)
