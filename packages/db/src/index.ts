import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export function createDb(connectionUrl: string) {
	const client = postgres(connectionUrl, {
		ssl: connectionUrl.includes('sslmode=verify-full') || connectionUrl.includes('sslmode=require')
			? 'require'
			: false,
	})
	return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDb>

export * from './schema/index.js'
