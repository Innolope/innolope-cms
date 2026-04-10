import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects.js'

export const webhooks = pgTable('webhooks', {
	id: uuid().defaultRandom().primaryKey(),
	projectId: uuid()
		.notNull()
		.references(() => projects.id, { onDelete: 'cascade' }),
	url: text().notNull(),
	secret: text().notNull(),
	events: jsonb().$type<string[]>().notNull().default([]),
	active: boolean().notNull().default(true),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('webhooks_project_idx').on(table.projectId),
])

export const webhookDeliveries = pgTable('webhook_deliveries', {
	id: uuid().defaultRandom().primaryKey(),
	webhookId: uuid()
		.notNull()
		.references(() => webhooks.id, { onDelete: 'cascade' }),
	event: text().notNull(),
	payload: jsonb().$type<Record<string, unknown>>().notNull(),
	status: text({ enum: ['pending', 'success', 'failed'] }).notNull().default('pending'),
	statusCode: integer(),
	responseBody: text(),
	attempts: integer().notNull().default(0),
	nextRetry: timestamp({ withTimezone: true }),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('deliveries_webhook_idx').on(table.webhookId),
	index('deliveries_status_retry_idx').on(table.status, table.nextRetry),
])
