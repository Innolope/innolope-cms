import { defineConfig } from 'drizzle-kit'

// Used only by `db:studio` (the schema browser). The schema in ./src/schema is
// the single source of truth; the DB is materialized at runtime by ensureTables()
// in apps/api/src/plugins/db.ts, so there are no migration files and no `out` dir.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('DATABASE_URL must be set to run drizzle-kit')
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/schema/index.ts',
	dbCredentials: {
		url: databaseUrl,
	},
})
