import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
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
	customDomain: text().unique(),
	customDomainToken: text(),
	customDomainVerifiedAt: timestamp({ withTimezone: true }),
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
		/**
		 * Per-member override for the project's review requirement.
		 *   NULL  → use the project default (owner/admin bypass, editor/viewer review)
		 *   TRUE  → can publish directly, skipping the pending_review state
		 *   FALSE → must always submit for review, even if role would normally bypass
		 * Only meaningful when `settings.requireReview` is true on the project.
		 */
		canPublishDirectly: boolean('canPublishDirectly'),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex('member_project_user_idx').on(table.projectId, table.userId)],
)

export interface ProjectSettings {
	locales: string[]
	defaultLocale: string
	mediaAdapter: 'local' | 'cloudflare' | 's3'
	/**
	 * When true, content goes through `draft → pending_review → published`.
	 * When false or undefined, "Submit" publishes directly.
	 *
	 * Defaults to off on solo projects (the auto-default at project creation
	 * sets it to false when the project has a single member). Admins can flip
	 * the toggle in Project Settings → General once a team is in place.
	 */
	requireReview?: boolean
	cloudflare?: {
		/** 'oauth' when managed by the Connect Cloudflare flow; 'manual' / unset otherwise. */
		source?: 'oauth' | 'manual'
		accountId?: string
		apiToken?: string
		imagesAccountHash?: string
		/**
		 * Cloudflare Images variant used when building delivery URLs
		 * (`imagedelivery.net/<hash>/<id>/<variant>`). Defaults to `public`,
		 * but accounts can rename or remove that variant.
		 */
		imagesVariant?: string
		r2Bucket?: string
		r2AccessKeyId?: string
		r2SecretAccessKey?: string
		r2Endpoint?: string
	}
}
