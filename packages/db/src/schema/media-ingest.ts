import {
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'
import { projects } from './projects.js'
import { users } from './users.js'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
export const mediaIngestLedger = pgTable(
	'media_ingest_ledger',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		targetKey: text().notNull(),
		sha256: text().notNull(),
		status: text({ enum: ['pending', 'done'] }).notNull(),
		claimId: uuid().notNull(),
		result: jsonb().$type<Record<string, unknown>>(),
		mediaId: uuid(),
		contentId: uuid(),
		externalId: text(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [uniqueIndex('media_ingest_dedupe_idx').on(t.projectId, t.targetKey, t.sha256)],
)
export const mediaUploadSessions = pgTable(
	'media_upload_sessions',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		filename: text().notNull(),
		mimeType: text().notNull(),
		bytes: integer().notNull(),
		tokenHash: text().notNull(),
		status: text({ enum: ['created', 'uploaded', 'processing', 'done'] })
			.notNull()
			.default('created'),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		data: bytea(),
		result: jsonb().$type<Record<string, unknown>>(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index('media_upload_expiry_idx').on(t.expiresAt)],
)
