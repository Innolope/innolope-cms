import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Instance-wide singleton: at most one row holds the active license key.
// The license applies to the whole instance, so this is not project-scoped.
export const licenseSettings = pgTable('license_settings', {
	id: uuid().defaultRandom().primaryKey(),
	licenseKey: text(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
})
