import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const webhooks = pgTable(
	'webhooks',
	{
		id: uuid().defaultRandom().primaryKey(),
		projectId: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		url: text().notNull(),
		secret: text().notNull(),
		events: jsonb().$type<string[]>().notNull().default([]),
		// Header name -> AES-256-GCM-encrypted value. Names stay plaintext so the
		// API can list them; values hold credentials (e.g. bearer tokens) and are
		// write-only after creation.
		headersEnc: jsonb().$type<Record<string, string>>(),
		// JSON template for the request body ({{...}} placeholders inside string
		// values). NULL sends the default CMS event envelope.
		customPayload: text(),
		active: boolean().notNull().default(true),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('webhooks_project_idx').on(table.projectId)],
)

export const webhookDeliveries = pgTable(
	'webhook_deliveries',
	{
		id: uuid().defaultRandom().primaryKey(),
		webhookId: uuid()
			.notNull()
			.references(() => webhooks.id, { onDelete: 'cascade' }),
		event: text().notNull(),
		payload: jsonb().$type<Record<string, unknown>>().notNull(),
		status: text({ enum: ['pending', 'success', 'failed'] })
			.notNull()
			.default('pending'),
		statusCode: integer(),
		responseBody: text(),
		// Exact body sent (truncated) — differs from `payload` when the webhook
		// uses a custom template; `payload` stays the render/retry source of truth.
		sentBody: text(),
		attempts: integer().notNull().default(0),
		nextRetry: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index('deliveries_webhook_idx').on(table.webhookId),
		index('deliveries_status_retry_idx').on(table.status, table.nextRetry),
	],
)
