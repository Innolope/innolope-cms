import { createDb, type Database } from '@innolope/db'
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

	const db = createDb(url)
	app.decorate('db', db)
	app.log.info('Database connected')
})
