import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { content } from './content.js'

// Note: The vector column and HNSW index are created via raw SQL in db.ts
// because Drizzle does not natively support the pgvector extension.
// This schema defines the non-vector columns for type inference.

export const contentEmbeddings = pgTable('content_embeddings', {
	id: uuid().defaultRandom().primaryKey(),
	contentId: uuid()
		.notNull()
		.references(() => content.id, { onDelete: 'cascade' }),
	chunkIndex: integer().notNull().default(0),
	chunkText: text().notNull(),
	model: text().notNull().default('text-embedding-3-small'),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('embeddings_content_idx').on(table.contentId),
])
