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

/** How a source table's shape changed since the collection last learned it. */
export interface ExternalSchemaDrift {
	detectedAt: string
	/** Columns or paths the source has that the recorded schema does not. */
	added: string[]
	/** Recorded columns or paths the source no longer has. */
	removed: string[]
	/** Columns or paths whose type, nullability or constraints changed. */
	changed: string[]
	/** Shape hash of the source as just observed. */
	hash: string
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
	// The source table's shape no longer matches the recorded `sourceSchema`.
	schemaDrift: jsonb().$type<ExternalSchemaDrift | null>(),
	schemaCheckedAt: timestamp({ withTimezone: true }),
})
