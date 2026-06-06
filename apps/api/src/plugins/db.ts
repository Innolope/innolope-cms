import { createDb, type Database, ensureTables } from '@innolope/db'
import fp from 'fastify-plugin'

declare module 'fastify' {
	interface FastifyInstance {
		db: Database
	}
}

export const dbPlugin = fp(async (app) => {
	const url = process.env.DATABASE_URL
	if (!url) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('DATABASE_URL is required in production')
		}
		app.log.warn('DATABASE_URL not set — database features disabled')
		return
	}

	// Schema is materialized here on every boot — there are no migration files.
	// See ensureTables() in @innolope/db (packages/db/src/ensure.ts).
	try {
		await ensureTables(url)
		app.log.info('Database tables ensured')
	} catch (err) {
		app.log.error(err, 'Failed to ensure database tables')
	}

	const db = createDb(url)
	app.decorate('db', db)
	app.log.info('Database connected')
})
