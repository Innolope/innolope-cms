import { pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { collections } from './collections.js'
import { projectMembers } from './projects.js'

// Per-member collection allowlist. Absence of rows for a member means
// "full access" (their project role decides what they can do). Presence
// of one or more rows restricts the member to exactly those collections.
// Owner/admin roles ignore this table — they always see everything.
export const projectMemberCollections = pgTable(
	'project_member_collections',
	{
		id: uuid().defaultRandom().primaryKey(),
		memberId: uuid()
			.notNull()
			.references(() => projectMembers.id, { onDelete: 'cascade' }),
		collectionId: uuid()
			.notNull()
			.references(() => collections.id, { onDelete: 'cascade' }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex('member_collection_idx').on(table.memberId, table.collectionId)],
)
