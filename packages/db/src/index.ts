import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sslModeFor } from './ensure.js'
import * as schema from './schema/index.js'

export function createDb(connectionUrl: string) {
	const client = postgres(connectionUrl, { ssl: sslModeFor(connectionUrl) })
	return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDb>

export { ensureTables, sslModeFor } from './ensure.js'
export * from './schema/index.js'
