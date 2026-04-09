import { projects } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'

export async function databaseRoutes(app: FastifyInstance) {
	// Test external database connection
	app.post<{ Params: { id: string } }>(
		'/:id/database/test',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { type, connectionString } = request.body as {
				type: string
				connectionString: string
			}

			if (!connectionString?.trim()) {
				return reply.status(400).send({ ok: false, message: 'Connection string is required.' })
			}

			try {
				switch (type) {
					case 'postgresql':
					case 'supabase':
					case 'vercel-postgres': {
						const client = postgres(connectionString, {
							ssl: connectionString.includes('sslmode=') ? 'require' : false,
							connect_timeout: 10,
						})
						await client`SELECT 1`
						await client.end()
						return { ok: true, message: 'Connected successfully.' }
					}
					case 'mongodb': {
						// Dynamic import to avoid bundling mongodb driver if not used
						const { MongoClient } = await import('mongodb')
						const client = new MongoClient(connectionString, {
							serverSelectionTimeoutMS: 10000,
						})
						await client.connect()
						await client.db().command({ ping: 1 })
						await client.close()
						return { ok: true, message: 'Connected successfully.' }
					}
					case 'mysql': {
						return { ok: false, message: 'MySQL support coming soon.' }
					}
					default:
						return reply.status(400).send({ ok: false, message: `Unsupported database type: ${type}` })
				}
			} catch (err) {
				return { ok: false, message: err instanceof Error ? err.message : 'Connection failed.' }
			}
		},
	)

	// Scan external database tables/collections
	app.post<{ Params: { id: string } }>(
		'/:id/database/scan',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { type, connectionString } = request.body as {
				type: string
				connectionString: string
			}

			try {
				switch (type) {
					case 'postgresql':
					case 'supabase':
					case 'vercel-postgres': {
						const client = postgres(connectionString, {
							ssl: connectionString.includes('sslmode=') ? 'require' : false,
							connect_timeout: 10,
						})

						const tables = await client`
							SELECT table_name FROM information_schema.tables
							WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
							ORDER BY table_name
						`

						const result = []
						for (const t of tables) {
							const columns = await client`
								SELECT column_name, data_type FROM information_schema.columns
								WHERE table_schema = 'public' AND table_name = ${t.table_name}
								ORDER BY ordinal_position
							`
							result.push({
								name: t.table_name as string,
								columns: columns.map((c) => ({
									name: String(c.column_name),
									type: String(c.data_type),
								})),
							})
						}

						await client.end()
						return { tables: result }
					}
					case 'mongodb': {
						const { MongoClient } = await import('mongodb')
						const client = new MongoClient(connectionString, {
							serverSelectionTimeoutMS: 10000,
						})
						await client.connect()
						const db = client.db()
						const collections = await db.listCollections().toArray()

						const result = []
						for (const col of collections) {
							// Sample one document to detect fields
							const sample = await db.collection(col.name).findOne()
							const columns = sample
								? Object.entries(sample).map(([name, value]) => ({
										name,
										type: typeof value,
									}))
								: []
							result.push({ name: col.name, columns })
						}

						await client.close()
						return { tables: result }
					}
					default:
						return reply.status(400).send({ error: 'Unsupported database type.' })
				}
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : 'Scan failed.',
				})
			}
		},
	)

	// Save external database config
	app.put<{ Params: { id: string } }>(
		'/:id/database',
		{ preHandler: [app.requireProject('admin')] },
		async (request) => {
			const { type, connectionString, tables } = request.body as {
				type: string | null
				connectionString: string | null
				tables?: string[]
			}

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, request.params.id))
				.limit(1)

			if (!project) return { error: 'Project not found' }

			const settings = (project.settings as unknown as Record<string, unknown>) || {}

			if (!type || type === 'built-in') {
				delete settings.externalDb
			} else {
				settings.externalDb = {
					type,
					connectionString,
					tables: tables || [],
				}
			}

			const [updated] = await app.db
				.update(projects)
				.set({ settings: settings as any, updatedAt: new Date() })
				.where(eq(projects.id, request.params.id))
				.returning()

			return updated
		},
	)
}
