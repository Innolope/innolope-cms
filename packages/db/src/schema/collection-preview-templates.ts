import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { collections } from './collections.js'
import { users } from './users.js'

export const collectionPreviewTemplates = pgTable('collection_preview_templates', {
	collectionId: uuid()
		.primaryKey()
		.references(() => collections.id, { onDelete: 'cascade' }),
	sourceUrl: text().notNull(),
	finalUrl: text().notNull(),
	html: text().notNull(),
	slots: jsonb()
		.$type<{
			title: {
				selector: string
				strategy: 'override' | 'record-match' | 'semantic' | 'heuristic'
				sample?: string
			} | null
			body: {
				selector: string
				strategy: 'override' | 'record-match' | 'semantic' | 'heuristic'
				sample?: string
			}
			image: {
				selector: string
				strategy: 'override' | 'record-match' | 'semantic' | 'heuristic'
				sample?: string
			} | null
		}>()
		.notNull(),
	classMap: jsonb().$type<Record<string, string>>().notNull().default({}),
	selectors: jsonb().$type<{ title?: string; body?: string; image?: string }>(),
	warnings: jsonb().$type<string[]>().notNull().default([]),
	stats: jsonb()
		.$type<{ bytes?: number; stylesheets?: number; inlinedFonts?: number }>()
		.notNull()
		.default({}),
	capturedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
	capturedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
