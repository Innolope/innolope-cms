import { projects, collections, content } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { createExternalDbAdapter } from '../../adapters/external-db.js'
import { mapColumnType, tableNameToLabel } from '../../adapters/type-mapper.js'
import { populateMarkdownCache } from '../../services/markdown-cache.js'

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
					case 'vercel-postgres':
					case 'neon':
					case 'cockroachdb': {
						const client = postgres(connectionString, {
							ssl: connectionString.includes('sslmode=') ? 'require' : false,
							connect_timeout: 10,
						})
						await client`SELECT 1`
						await client.end()
						return { ok: true, message: 'Connected successfully.' }
					}
					case 'mongodb': {
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
						const mysql = await import('mysql2/promise')
						const conn = await mysql.createConnection(connectionString)
						await conn.execute('SELECT 1')
						await conn.end()
						return { ok: true, message: 'Connected successfully.' }
					}
					case 'firebase': {
						const admin = await import('firebase-admin')
						const credentials = JSON.parse(connectionString)
						const app = admin.initializeApp({
							credential: admin.credential.cert(credentials),
						}, `test-${Date.now()}`)
						const firestore = app.firestore()
						await firestore.listCollections()
						await app.delete()
						return { ok: true, message: 'Connected successfully.' }
					}
					default:
						return reply.status(400).send({ ok: false, message: `Unsupported database type: ${type}` })
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Connection failed.'
				// Detect IP whitelisting / network access errors
				const ipKeywords = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'getaddrinfo', 'connect EHOSTUNREACH', 'Server selection timed out', 'authentication failed', 'not whitelisted', 'IP address']
				const isNetworkError = ipKeywords.some(kw => msg.includes(kw))
				if (isNetworkError) {
					const sshHost = process.env.SSH_HOST
					const hint = sshHost
						? ` If your database requires IP whitelisting, add ${sshHost} to your allow list.`
						: ' If your database requires IP whitelisting, add this server\'s IP to your allow list.'
					return { ok: false, message: msg + hint }
				}
				return { ok: false, message: msg }
			}
		},
	)

	// Scan external database tables/collections
	app.post<{ Params: { id: string } }>(
		'/:id/database/scan',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { type, connectionString, database } = request.body as {
				type: string
				connectionString: string
				database?: string
			}

			try {
				switch (type) {
					case 'postgresql':
					case 'supabase':
					case 'vercel-postgres':
					case 'neon':
					case 'cockroachdb': {
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
							const [{ count }] = await client`SELECT count(*)::int as count FROM ${client(t.table_name as string)}`
							result.push({
								name: t.table_name as string,
								columns: columns.map((c) => ({
									name: String(c.column_name),
									type: String(c.data_type),
								})),
								count: Number(count),
							})
						}

						const [{ size: pgSize }] = await client`SELECT pg_database_size(current_database()) as size`
						await client.end()
						return { tables: result, estimatedSizeBytes: Number(pgSize) }
					}
					case 'mongodb': {
						const { MongoClient } = await import('mongodb')
						const client = new MongoClient(connectionString, {
							serverSelectionTimeoutMS: 10000,
						})
						await client.connect()
						const db = database ? client.db(database) : client.db()
						const collections = await db.listCollections().toArray()

						const result = []
						for (const col of collections) {
							const coll = db.collection(col.name)
							const sample = await coll.findOne()
							const columns = sample
								? Object.entries(sample).map(([name, value]) => ({
										name,
										type: typeof value,
									}))
								: []
							const count = await coll.estimatedDocumentCount()
							result.push({ name: col.name, columns, count })
						}

						const mongoStats = await db.stats()
						await client.close()
						return { tables: result, estimatedSizeBytes: mongoStats.dataSize || 0 }
					}
					case 'mysql': {
						const mysql = await import('mysql2/promise')
						const conn = await mysql.createConnection(connectionString)

						const [tableRows] = await conn.execute(
							`SELECT table_name FROM information_schema.tables
							 WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
							 ORDER BY table_name`,
						)

						const result = []
						for (const t of tableRows as Array<{ table_name: string }>) {
							const [colRows] = await conn.execute(
								`SELECT column_name, data_type FROM information_schema.columns
								 WHERE table_schema = DATABASE() AND table_name = ?
								 ORDER BY ordinal_position`,
								[t.table_name],
							)
							const [countRows] = await conn.execute(`SELECT COUNT(*) as count FROM \`${t.table_name}\``)
							const countRow = (countRows as Array<{ count: number }>)[0]
							result.push({
								name: t.table_name,
								columns: (colRows as Array<{ column_name: string; data_type: string }>).map((c) => ({
									name: c.column_name,
									type: c.data_type,
								})),
								count: Number(countRow.count),
							})
						}

						const [sizeRows] = await conn.execute(`SELECT SUM(data_length + index_length) as size FROM information_schema.tables WHERE table_schema = DATABASE()`)
						const mysqlSize = Number((sizeRows as Array<{ size: number }>)[0]?.size || 0)
						await conn.end()
						return { tables: result, estimatedSizeBytes: mysqlSize }
					}
					case 'firebase': {
						const admin = await import('firebase-admin')
						const credentials = JSON.parse(connectionString)
						const app = admin.initializeApp({
							credential: admin.credential.cert(credentials),
						}, `scan-${Date.now()}`)
						const firestore = app.firestore()
						const collections = await firestore.listCollections()

						const result = []
						for (const col of collections) {
							const snapshot = await col.limit(1).get()
							const columns = snapshot.empty
								? []
								: Object.entries(snapshot.docs[0].data()).map(([name, value]) => ({
										name,
										type: typeof value,
									}))
							result.push({ name: col.id, columns })
						}

						await app.delete()
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

	// Scan available databases (for MongoDB/Firebase where you pick a database first)
	app.post<{ Params: { id: string } }>(
		'/:id/database/scan-databases',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { type, connectionString } = request.body as {
				type: string
				connectionString: string
			}

			try {
				switch (type) {
					case 'mongodb': {
						const { MongoClient } = await import('mongodb')
						const client = new MongoClient(connectionString, {
							serverSelectionTimeoutMS: 10000,
						})
						await client.connect()
						const adminDb = client.db().admin()
						const { databases: dbList } = await adminDb.listDatabases()
						await client.close()
						return {
							databases: dbList
								.map((d: { name: string }) => d.name)
								.filter((n: string) => !['admin', 'local', 'config'].includes(n)),
						}
					}
					case 'firebase': {
						const admin = await import('firebase-admin')
						const credentials = JSON.parse(connectionString)
						const app = admin.initializeApp({
							credential: admin.credential.cert(credentials),
						}, `scan-dbs-${Date.now()}`)
						// Firestore has a single default database per project
						await app.delete()
						return { databases: ['(default)'] }
					}
					default:
						return reply.status(400).send({ error: 'This database type does not support database scanning.' })
				}
			} catch (err) {
				return reply.status(500).send({
					error: err instanceof Error ? err.message : 'Scan failed.',
				})
			}
		},
	)

	// Save external database config + create collection records
	app.put<{ Params: { id: string } }>(
		'/:id/database',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { type, connectionString, database, tables, accessMode } = request.body as {
				type: string | null
				connectionString: string | null
				database?: string | null
				tables?: Array<{ name: string; columns: { name: string; type: string }[]; count?: number }>
				accessMode?: 'read-write' | 'read-only'
			}

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, request.params.id))
				.limit(1)

			if (!project) return reply.status(404).send({ error: 'Project not found' })

			const settings = (project.settings as unknown as Record<string, unknown>) || {}
			const warnings: string[] = []

			if (!type || type === 'built-in') {
				delete settings.externalDb
			} else {
				settings.externalDb = {
					type,
					connectionString,
					database: database || undefined,
					tables: (tables || []).map(t => t.name),
					accessMode: accessMode || 'read-write',
				}
			}

			// Update project settings
			const [updated] = await app.db
				.update(projects)
				.set({ settings: settings as any, updatedAt: new Date() })
				.where(eq(projects.id, request.params.id))
				.returning()

			// Create collection records for selected tables
			const createdCollections: Array<typeof collections.$inferSelect> = []

			if (type && type !== 'built-in' && tables?.length && connectionString) {
				const mode = accessMode || 'read-write'

				// Test write permissions if read-write requested
				let effectiveMode = mode
				if (mode === 'read-write') {
					try {
						const adapter = createExternalDbAdapter({ type, connectionString, database: database || undefined })
						await adapter.connect()
						const canWrite = await adapter.testWritePermission(tables[0].name)
						await adapter.disconnect()
						if (!canWrite) {
							effectiveMode = 'read-only'
							warnings.push('Write permissions not available. Collections set to read-only.')
						}
					} catch {
						effectiveMode = 'read-only'
						warnings.push('Could not verify write permissions. Collections set to read-only.')
					}
				}

				for (const table of tables) {
					// Skip if collection already exists
					const [existing] = await app.db
						.select({ id: collections.id })
						.from(collections)
						.where(and(eq(collections.name, table.name), eq(collections.projectId, request.params.id)))
						.limit(1)

					if (existing) continue

					// Map column types to field types
					const fields = table.columns
						.filter(c => c.name !== '_id' && c.name !== 'id')
						.map(c => ({
							name: c.name,
							type: mapColumnType(c.type) as any,
							required: false,
							localized: false,
						}))

					const [created] = await app.db
						.insert(collections)
						.values({
							projectId: request.params.id,
							name: table.name,
							label: tableNameToLabel(table.name),
							description: `Imported from ${type}`,
							fields,
							source: 'external',
							externalTable: table.name,
							accessMode: effectiveMode,
						})
						.returning()

					createdCollections.push(created)
				}

				// Populate markdown cache if DB is small enough
				const cacheLimitMb = Number(process.env.EXTERNAL_DB_CACHE_LIMIT_MB)
					|| (settings.externalDb as Record<string, unknown>)?.cacheLimitMb as number
					|| 100
				const cacheLimitBytes = cacheLimitMb * 1024 * 1024

				if (createdCollections.length > 0) {
					try {
						const adapter = createExternalDbAdapter({ type, connectionString, database: database || undefined })
						await adapter.connect()
						const sizeBytes = await adapter.estimateSizeBytes()

						if (sizeBytes <= cacheLimitBytes) {
							for (const col of createdCollections) {
								if (col.externalTable) {
									await populateMarkdownCache(app.db, content, adapter, {
										id: col.id,
										projectId: col.projectId,
										externalTable: col.externalTable,
										fields: col.fields,
									}, { userId: request.user?.id })
								}
							}
						} else {
							const sizeMb = Math.round(sizeBytes / 1024 / 1024)
							warnings.push(`Database is ${sizeMb} MB (limit: ${cacheLimitMb} MB). Content will be cached on demand.`)
						}

						await adapter.disconnect()
					} catch (err) {
						warnings.push(`Cache population failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
					}
				}
			}

			return {
				project: updated,
				collections: createdCollections,
				warnings: warnings.length > 0 ? warnings : undefined,
			}
		},
	)
}
