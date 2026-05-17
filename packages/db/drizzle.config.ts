import { defineConfig } from 'drizzle-kit'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('DATABASE_URL must be set to run drizzle-kit')
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/schema/index.ts',
	out: './drizzle',
	dbCredentials: {
		url: databaseUrl,
	},
})
