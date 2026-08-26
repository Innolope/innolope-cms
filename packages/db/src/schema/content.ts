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
import { users } from './users.js'

/**
 * Mirrors CONTENT_SOURCES in @innolope/config. Kept as a literal (not an import)
 * so the schema package stays dependency-free.
 */
const CONTENT_SOURCES = ['admin', 'mcp', 'api', 'import', 'system'] as const

export const content = pgTable(
	'content',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		// Nullable: imported records whose source row carried no title/name/slug-like
		// field leave this null. Manual new records auto-derive from the resolved
		// display title at save time. Postgres treats nulls as distinct in the
		// unique index, so multiple null-slug rows can coexist.
		slug: text(),
		// Mirrors CONTENT_STATUSES in @innolope/config. `scheduled` rows are picked up
		// by services/scheduled-publisher.ts once `publishedAt` passes. Kept as a
		// literal (not an import) so the schema package stays dependency-free.
		status: text({ enum: ['draft', 'pending_review', 'scheduled', 'published', 'archived'] })
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
		externalId: text(),
		createdBy: uuid().references(() => users.id),
		// Actor and client behind the CURRENT state of the row. `createdBy` cannot
		// answer "was this last touched by a human in the admin UI or by an agent
		// over MCP" — the question a field that looks unexpectedly reformatted
		// always raises. Nullable: rows written before these columns existed have
		// no attribution to backfill, and a null reads as "unknown", not "admin".
		//
		// Set by writes that change what the record SAYS — an edit, a status
		// transition, a cover being attached — including the unattended ones, which
		// record `system`. Deliberately NOT set by mechanical rewrites that only
		// re-point asset URLs (the Cloudflare media migration, external media-path
		// sync): those touch every row at once and would erase the human-or-agent
		// signal across a whole library without an authoring event behind it.
		updatedBy: uuid().references(() => users.id),
		updatedSource: text({ enum: CONTENT_SOURCES }),
	},
	(table) => [
		uniqueIndex('content_slug_locale_project_idx').on(table.slug, table.locale, table.projectId),
		index('content_project_collection_status_idx').on(
			table.projectId,
			table.collectionId,
			table.status,
		),
		index('content_project_collection_external_idx').on(
			table.projectId,
			table.collectionId,
			table.externalId,
		),
		index('content_project_status_created_idx').on(table.projectId, table.status, table.createdAt),
		index('content_project_updated_idx').on(table.projectId, table.updatedAt),
	],
)

export const contentVersions = pgTable(
	'content_versions',
	{
		id: uuid().defaultRandom().primaryKey(),
		contentId: uuid()
			.notNull()
			.references(() => content.id, { onDelete: 'cascade' }),
		version: integer().notNull(),
		markdown: text().notNull(),
		metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		createdBy: uuid().references(() => users.id),
		// The client that performed the write which ARCHIVED this row. A version row
		// snapshots the state an edit replaced, so `createdBy`/`source`/`createdAt`
		// describe that superseding edit — not the authorship of the payload. Read a
		// row as "superseded by X via mcp at T". The current state's own attribution
		// lives on content.updatedBy / content.updatedSource.
		source: text({ enum: CONTENT_SOURCES }),
	},
	(table) => [index('versions_content_idx').on(table.contentId, table.version)],
)
