import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { collections } from './collections.js'

export interface ExternalSyncConflict {
	contentId: string
	externalId: string
	slug: string | null
	metadata: Record<string, unknown>
	token: string
	categories: Array<'content' | 'details' | 'status'>
	local?: { metadata: Record<string, unknown>; markdown: string; status: string }
	external?: { metadata: Record<string, unknown>; markdown: string; status: string }
}

/** Durable conflicts and a renewable lease shared by manual sync and API workers. */
export const externalSyncState = pgTable('external_sync_state', {
	collectionId: uuid()
		.primaryKey()
		.references(() => collections.id, { onDelete: 'cascade' }),
	leaseToken: uuid(),
	leaseUntil: timestamp({ withTimezone: true }),
	nextAttemptAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	lastAttemptAt: timestamp({ withTimezone: true }),
	lastError: text(),
	failureCount: integer().default(0).notNull(),
	conflicts: jsonb().$type<ExternalSyncConflict[]>().default([]).notNull(),
})
