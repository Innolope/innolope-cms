import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'
import { collections } from './collections.js'
import { projects } from './projects.js'

/**
 * Public URLs waiting to be submitted to IndexNow. One row per URL per project:
 * a second change to a URL that is still queued is already covered by the row.
 * `nextAttemptAt` is the debounce deadline for a fresh row and the backoff
 * deadline for a retried one; `leaseUntil` keeps a sibling instance off rows
 * that are being sent.
 */
export const indexNowQueue = pgTable(
	'indexnow_queue',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		// Kept (as null) when the collection is deleted: its pages are gone from the
		// site, which is exactly what the queued submission tells search engines.
		collectionId: uuid().references(() => collections.id, { onDelete: 'set null' }),
		host: text().notNull(),
		url: text().notNull(),
		reason: text({ enum: ['change', 'resubmit'] })
			.notNull()
			.default('change'),
		attempts: integer().notNull().default(0),
		nextAttemptAt: timestamp({ withTimezone: true }).notNull(),
		leaseToken: uuid(),
		leaseUntil: timestamp({ withTimezone: true }),
		lastError: text(),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('indexnow_queue_project_url_idx').on(table.projectId, table.url),
		index('indexnow_queue_due_idx').on(table.nextAttemptAt),
	],
)

/** One row per IndexNow request (or per held batch), shown in the admin. */
export const indexNowSubmissions = pgTable(
	'indexnow_submissions',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		collectionId: uuid().references(() => collections.id, { onDelete: 'set null' }),
		host: text().notNull(),
		urlCount: integer().notNull(),
		// The first few URLs of the request, so a failure can be reproduced.
		sampleUrls: jsonb().$type<string[]>().notNull().default([]),
		status: text({ enum: ['success', 'retrying', 'waiting', 'failed'] }).notNull(),
		statusCode: integer(),
		message: text(),
		trigger: text({ enum: ['change', 'resubmit'] })
			.notNull()
			.default('change'),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index('indexnow_submissions_project_idx').on(
			table.projectId,
			table.collectionId,
			table.createdAt,
		),
	],
)
