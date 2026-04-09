import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const projects = pgTable('projects', {
	id: uuid().defaultRandom().primaryKey(),
	name: text().notNull(),
	slug: text().notNull().unique(),
	ownerId: uuid()
		.notNull()
		.references(() => users.id),
	settings: jsonb()
		.$type<ProjectSettings>()
		.notNull()
		.default({
			locales: ['en'],
			defaultLocale: 'en',
			mediaAdapter: 'local',
		}),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
})

export const projectMembers = pgTable(
	'project_members',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		role: text({ enum: ['owner', 'admin', 'editor', 'viewer'] })
			.notNull()
			.default('viewer'),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex('member_project_user_idx').on(table.projectId, table.userId)],
)

export interface ProjectSettings {
	locales: string[]
	defaultLocale: string
	mediaAdapter: 'local' | 'cloudflare' | 's3'
	cloudflare?: {
		accountId?: string
		apiToken?: string
		imagesAccountHash?: string
		r2Bucket?: string
	}
}
