import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { collections } from './collections.js'
import { projects } from './projects.js'
import { users } from './users.js'

export const content = pgTable('content', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	slug: text().notNull(),
	status: text({ enum: ['draft', 'pending_review', 'published', 'archived'] })
		.notNull()
		.default('draft'),
	collectionId: uuid()
		.notNull()
		.references(() => collections.id, { onDelete: 'cascade' }),
	metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
	markdown: text().notNull().default(''),
	html: text().notNull().default(''),
	locale: text().notNull().default('en'),
	version: integer().notNull().default(1),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	publishedAt: timestamp({ withTimezone: true }),
	createdBy: uuid().references(() => users.id),
}, (table) => [
	uniqueIndex('content_slug_locale_project_idx').on(table.slug, table.locale, table.projectId),
	index('content_project_collection_status_idx').on(table.projectId, table.collectionId, table.status),
	index('content_project_status_created_idx').on(table.projectId, table.status, table.createdAt),
	index('content_project_updated_idx').on(table.projectId, table.updatedAt),
])

export const contentVersions = pgTable('content_versions', {
	id: uuid().defaultRandom().primaryKey(),
	contentId: uuid()
		.notNull()
		.references(() => content.id, { onDelete: 'cascade' }),
	version: integer().notNull(),
	markdown: text().notNull(),
	metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	createdBy: uuid().references(() => users.id),
}, (table) => [
	index('versions_content_idx').on(table.contentId, table.version),
])
