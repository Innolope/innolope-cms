import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const aiSettings = pgTable('ai_settings', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' })
		.unique(),
	defaultModel: text().notNull().default('gemini-3.1-flash-lite'),
	providers: jsonb()
		.$type<AiProviderConfig[]>()
		.notNull()
		.default([]),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
})

export interface AiProviderConfig {
	provider: 'anthropic' | 'openai' | 'google' | 'openrouter'
	apiKey: string
	enabled: boolean
}

// Models are defined in apps/api/src/services/ai.ts (single source of truth)
