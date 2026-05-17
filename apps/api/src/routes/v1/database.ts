import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { CollectionField } from '@innolope/config'
import { collections, content, projects } from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { createExternalDbAdapter } from '../../adapters/external-db.js'
import { mapColumnType, tableNameToLabel } from '../../adapters/type-mapper.js'
import { getProject } from '../../plugins/project.js'
import { populateMarkdownCache } from '../../services/markdown-cache.js'

/** Block connection strings targeting private/internal networks (SSRF protection). */
export async function validateConnectionString(connStr: string): Promise<string | null> {
	const lc = connStr.toLowerCase()
	const blockedPatterns = [
		'localhost',
		'127.0.0.1',
		'::1',
		'0.0.0.0',
		'10.',
		'172.16.',
		'172.17.',
		'172.18.',
		'172.19.',
		'172.20.',
		'172.21.',
		'172.22.',
		'172.23.',
		'172.24.',
		'172.25.',
		'172.26.',
		'172.27.',
		'172.28.',
		'172.29.',
		'172.30.',
		'172.31.',
		'192.168.',
		'169.254.',
		'.internal',
		'.local',
		'metadata.google',
	]
	for (const pattern of blockedPatterns) {
		if (lc.includes(pattern)) {
			return `Connection to private/internal addresses is not allowed (matched: ${pattern}).`
		}
	}

	const hostname = extractHostname(connStr)
	if (!hostname) return null

	let addresses: string[]
	if (isIP(hostname)) {
		addresses = [hostname]
	} else {
		try {
			const resolved = await lookup(hostname, { all: true, verbatim: true })
			addresses = resolved.map((entry) => entry.address)
		} catch {
			return null
		}
	}

	for (const address of addresses) {
		if (isPrivateAddress(address)) {
			return `Connection to private/internal addresses is not allowed (resolved: ${address}).`
		}
	}
	return null
}

function extractHostname(connStr: string): string | null {
	try {
		const parsed = new URL(connStr)
		return parsed.hostname.replace(/^\[|\]$/g, '')
	} catch {
		return null
	}
}

function isPrivateAddress(address: string): boolean {
	if (address.includes(':')) {
		const normalized = address.toLowerCase()
		return (
			normalized === '::1' ||
			normalized === '::' ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			normalized.startsWith('fe80:') ||
			normalized.startsWith('::ffff:127.') ||
			normalized.startsWith('::ffff:10.') ||
			normalized.startsWith('::ffff:192.168.') ||
			/^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
		)
	}

	const parts = address.split('.').map(Number)
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
	const [a, b] = parts
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		a === 0 ||
		a >= 224
	)
}

function getSavedExternalDb(project: typeof projects.$inferSelect) {
	return ((project.settings as unknown as Record<string, unknown>)?.externalDb || {}) as Record<
		string,
		unknown
	>
}

function sanitizeProject(project: typeof projects.$inferSelect) {
	const settings = { ...((project.settings as unknown as Record<string, unknown>) || {}) }
	const externalDb = settings.externalDb as Record<string, unknown> | undefined
	if (externalDb) {
		// Strip media-storage credentials; expose only a `hasCredentials` flag.
		const mediaStorage = externalDb.mediaStorage as
			| Record<string, Record<string, unknown>>
			| undefined
		const sanitizedMedia = mediaStorage
			? Object.fromEntries(
					Object.entries(mediaStorage).map(([table, entry]) => {
						const { credentials, ...rest } = entry
						return [
							table,
							{
								...rest,
								hasCredentials: Boolean(
									credentials &&
										typeof credentials === 'object' &&
										Object.keys(credentials).length > 0,
								),
							},
						]
					}),
				)
			: undefined
		settings.externalDb = {
			...externalDb,
			connectionString: undefined,
			hasConnectionString: Boolean(externalDb.connectionString),
			...(sanitizedMedia ? { mediaStorage: sanitizedMedia } : {}),
		}
	}
	return { ...project, settings }
}

const FIELD_TYPES = new Set([
	'text',
	'number',
	'boolean',
	'date',
	'enum',
	'relation',
	'object',
	'array',
])

/** Classify a runtime MongoDB value into a CollectionField type. */
function classifyMongoValue(value: unknown): {
	type: string
	isObjectId: boolean
	isArray: boolean
} {
	if (value === null || value === undefined)
		return { type: 'unknown', isObjectId: false, isArray: false }
	if (typeof value === 'object' && (value as { _bsontype?: string })._bsontype === 'ObjectId') {
		return { type: 'relation', isObjectId: true, isArray: false }
	}
	if (value instanceof Date) return { type: 'date', isObjectId: false, isArray: false }
	if (Array.isArray(value)) {
		const first = value[0]
		if (
			first &&
			typeof first === 'object' &&
			(first as { _bsontype?: string })._bsontype === 'ObjectId'
		) {
			return { type: 'relation', isObjectId: true, isArray: true }
		}
		return { type: 'array', isObjectId: false, isArray: true }
	}
	const t = typeof value
	if (t === 'string') return { type: 'text', isObjectId: false, isArray: false }
	if (t === 'number') return { type: 'number', isObjectId: false, isArray: false }
	if (t === 'boolean') return { type: 'boolean', isObjectId: false, isArray: false }
	return { type: 'object', isObjectId: false, isArray: false }
}

/** Parse a Firebase service-account JSON connection string, failing with a clear 400. */
export function parseFirebaseCredentials(connStr: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(connStr)
	} catch {
		const err = new Error(
			'Invalid Firebase service-account JSON. Paste the full contents of the service-account key file.',
		) as Error & { statusCode?: number }
		err.statusCode = 400
		throw err
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		const err = new Error('Firebase credentials must be a JSON object.') as Error & {
			statusCode?: number
		}
		err.statusCode = 400
		throw err
	}
	return parsed as Record<string, unknown>
}

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

			const ssrfError = await validateConnectionString(connectionString)
			if (ssrfError) {
				return reply.status(400).send({ ok: false, message: ssrfError })
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
						const credentials = parseFirebaseCredentials(connectionString)
						const app = admin.initializeApp(
							{
								credential: admin.credential.cert(credentials),
							},
							`test-${Date.now()}`,
						)
						const firestore = app.firestore()
						await firestore.listCollections()
						await app.delete()
						return { ok: true, message: 'Connected successfully.' }
					}
					default:
						return reply
							.status(400)
							.send({ ok: false, message: `Unsupported database type: ${type}` })
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Connection failed.'
				// Detect IP whitelisting / network access errors
				const ipKeywords = [
					'ECONNREFUSED',
					'ETIMEDOUT',
					'ENOTFOUND',
					'getaddrinfo',
					'connect EHOSTUNREACH',
					'Server selection timed out',
					'authentication failed',
					'not whitelisted',
					'IP address',
				]
				const isNetworkError = ipKeywords.some((kw) => msg.includes(kw))
				if (isNetworkError) {
					const sshHost = process.env.SSH_HOST
					const hint = sshHost
						? ` If your database requires IP whitelisting, add ${sshHost} to your allow list.`
						: " If your database requires IP whitelisting, add this server's IP to your allow list."
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

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			if (!project) return reply.status(404).send({ error: 'Project not found' })
			const savedExternalDb = getSavedExternalDb(project)
			const effectiveConnectionString =
				connectionString || (savedExternalDb.connectionString as string | undefined)
			const effectiveDatabase = database || (savedExternalDb.database as string | undefined)

			if (!effectiveConnectionString)
				return reply.status(400).send({ error: 'Connection string is required.' })

			const ssrfErr = await validateConnectionString(effectiveConnectionString)
			if (ssrfErr) {
				return reply.status(400).send({ error: ssrfErr })
			}

			try {
				switch (type) {
					case 'postgresql':
					case 'supabase':
					case 'vercel-postgres':
					case 'neon':
					case 'cockroachdb': {
						const client = postgres(effectiveConnectionString, {
							ssl: effectiveConnectionString.includes('sslmode=') ? 'require' : false,
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
							const [{ count }] =
								await client`SELECT count(*)::int as count FROM ${client(t.table_name as string)}`
							const [{ size }] =
								await client`SELECT pg_total_relation_size(${t.table_name}::regclass) as size`
							result.push({
								name: t.table_name as string,
								columns: columns.map((c) => ({
									name: String(c.column_name),
									type: String(c.data_type),
								})),
								count: Number(count),
								sizeBytes: Number(size) || 0,
							})
						}

						await client.end()
						return { tables: result }
					}
					case 'mongodb': {
						const { MongoClient } = await import('mongodb')
						const client = new MongoClient(effectiveConnectionString, {
							serverSelectionTimeoutMS: 10000,
						})
						await client.connect()
						const db = effectiveDatabase ? client.db(effectiveDatabase) : client.db()
						const collections = await db.listCollections().toArray()

						// First pass: sample documents and classify each field's type.
						type FieldInfo = {
							type: string
							isArray: boolean
							objectIdSamples: unknown[]
							relationTo?: string
						}
						const scanned: Array<{
							name: string
							count: number
							sizeBytes: number
							fields: Map<string, FieldInfo>
						}> = []

						for (const col of collections) {
							const coll = db.collection(col.name)
							const samples = await coll.find().limit(20).toArray()
							const fields = new Map<string, FieldInfo>()
							for (const doc of samples) {
								for (const [name, value] of Object.entries(doc)) {
									// _id is the primary key, never an importable field — skip it so it
									// isn't mis-detected as a self-relation (which is very slow to probe).
									if (name === '_id') continue
									const cls = classifyMongoValue(value)
									if (cls.type === 'unknown') continue
									let entry = fields.get(name)
									if (!entry) {
										entry = { type: cls.type, isArray: cls.isArray, objectIdSamples: [] }
										fields.set(name, entry)
									}
									if (cls.isObjectId) {
										const ids = cls.isArray ? (value as unknown[]) : [value]
										for (const id of ids) {
											if (entry.objectIdSamples.length < 10) entry.objectIdSamples.push(id)
										}
									}
								}
							}
							const count = await coll.estimatedDocumentCount()
							let sizeBytes = 0
							try {
								const collStats = await db.command({ collStats: col.name })
								sizeBytes = Number(collStats.size) || 0
							} catch {
								// collStats unavailable (e.g. on a view) — leave size at 0
							}
							scanned.push({ name: col.name, count, sizeBytes, fields })
						}

						// Second pass: resolve relation targets. Gather every sampled reference id, then
						// find which collection each id lives in (one query per collection) and map fields.
						const relationEntries: Array<{ entry: FieldInfo; ids: import('mongodb').ObjectId[] }> =
							[]
						for (const tbl of scanned) {
							for (const entry of tbl.fields.values()) {
								if (entry.type === 'relation' && entry.objectIdSamples.length > 0) {
									relationEntries.push({
										entry,
										ids: entry.objectIdSamples as import('mongodb').ObjectId[],
									})
								}
							}
						}
						if (relationEntries.length > 0) {
							const allIds = relationEntries.flatMap((r) => r.ids)
							const idToCollection = new Map<string, string>()
							for (const candidate of scanned) {
								try {
									const hits = await db
										.collection(candidate.name)
										.find({ _id: { $in: allIds } }, { projection: { _id: 1 } })
										.toArray()
									for (const hit of hits) idToCollection.set(String(hit._id), candidate.name)
								} catch {
									// Collection could not be probed — skip it.
								}
							}
							for (const { entry, ids } of relationEntries) {
								const tally = new Map<string, number>()
								for (const id of ids) {
									const target = idToCollection.get(String(id))
									if (target) tally.set(target, (tally.get(target) ?? 0) + 1)
								}
								let best: string | undefined
								let bestCount = 0
								for (const [target, count] of tally) {
									if (count > bestCount) {
										bestCount = count
										best = target
									}
								}
								if (best) entry.relationTo = best
							}
						}

						const result = scanned.map((tbl) => ({
							name: tbl.name,
							columns: [...tbl.fields.entries()].map(([name, entry]) => ({
								name,
								type: entry.type,
								...(entry.relationTo && { relationTo: entry.relationTo }),
								...(entry.type === 'relation' && entry.isArray && { relationIsArray: true }),
							})),
							count: tbl.count,
							sizeBytes: tbl.sizeBytes,
						}))

						await client.close()
						return { tables: result }
					}
					case 'mysql': {
						const mysql = await import('mysql2/promise')
						const conn = await mysql.createConnection(effectiveConnectionString)

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
							const [countRows] = await conn.execute(
								`SELECT COUNT(*) as count FROM \`${t.table_name}\``,
							)
							const countRow = (countRows as Array<{ count: number }>)[0]
							const [sizeRows] = await conn.execute(
								`SELECT data_length + index_length as size FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
								[t.table_name],
							)
							result.push({
								name: t.table_name,
								columns: (colRows as Array<{ column_name: string; data_type: string }>).map(
									(c) => ({
										name: c.column_name,
										type: c.data_type,
									}),
								),
								count: Number(countRow.count),
								sizeBytes: Number((sizeRows as Array<{ size: number }>)[0]?.size || 0),
							})
						}

						await conn.end()
						return { tables: result }
					}
					case 'firebase': {
						const admin = await import('firebase-admin')
						const credentials = parseFirebaseCredentials(effectiveConnectionString)
						const app = admin.initializeApp(
							{
								credential: admin.credential.cert(credentials),
							},
							`scan-${Date.now()}`,
						)
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
				const statusCode = (err as { statusCode?: number }).statusCode || 500
				return reply.status(statusCode).send({
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

			const ssrfErr2 = await validateConnectionString(connectionString)
			if (ssrfErr2) {
				return reply.status(400).send({ error: ssrfErr2 })
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
						const credentials = parseFirebaseCredentials(connectionString)
						const app = admin.initializeApp(
							{
								credential: admin.credential.cert(credentials),
							},
							`scan-dbs-${Date.now()}`,
						)
						// Firestore has a single default database per project
						await app.delete()
						return { databases: ['(default)'] }
					}
					default:
						return reply
							.status(400)
							.send({ error: 'This database type does not support database scanning.' })
				}
			} catch (err) {
				const statusCode = (err as { statusCode?: number }).statusCode || 500
				return reply.status(statusCode).send({
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
			const { type, connectionString, database, tables, accessMode, mediaStorage } =
				request.body as {
					type: string | null
					connectionString: string | null
					database?: string | null
					tables?: Array<{
						name: string
						columns: {
							name: string
							type: string
							relationTo?: string
							relationIsArray?: boolean
						}[]
						count?: number
					}>
					accessMode?: 'read-write' | 'read-only'
					mediaStorage?: Record<string, { adapter: string; pathColumn: string; baseUrl?: string }>
				}

			if (connectionString) {
				const ssrfErr3 = await validateConnectionString(connectionString)
				if (ssrfErr3) {
					return reply.status(400).send({ error: ssrfErr3 })
				}
			}

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)

			if (!project) return reply.status(404).send({ error: 'Project not found' })

			const settings = (project.settings as unknown as Record<string, unknown>) || {}
			const warnings: string[] = []

			// Fall back to the saved connection string/database when the client omits them
			// (re-sync from the settings page never re-sends the secret connection string).
			const savedExternalDb = getSavedExternalDb(project)
			const effectiveConnectionString =
				connectionString || (savedExternalDb.connectionString as string | undefined) || null
			const effectiveDatabase = database || (savedExternalDb.database as string | undefined)

			if (!type || type === 'built-in') {
				delete settings.externalDb
			} else {
				settings.externalDb = {
					type,
					connectionString: effectiveConnectionString,
					database: effectiveDatabase || undefined,
					tables: (tables || []).map((t) => t.name),
					accessMode:
						accessMode || (savedExternalDb.accessMode as string | undefined) || 'read-write',
					// Where an imported media library stores its files (reference-only resolution).
					// Falls back to the saved value so a re-sync doesn't drop it.
					mediaStorage:
						mediaStorage ||
						(savedExternalDb.mediaStorage as Record<string, unknown> | undefined) ||
						undefined,
				}
			}

			// Update project settings
			const [updated] = await app.db
				.update(projects)
				.set({
					settings: settings as unknown as (typeof projects.$inferInsert)['settings'],
					updatedAt: new Date(),
				})
				.where(eq(projects.id, getProject(request).id))
				.returning()

			// Create collection records for selected tables
			const createdCollections: Array<typeof collections.$inferSelect> = []
			// Every selected collection (new or already-imported) whose content cache should be filled.
			const cacheTargets: Array<typeof collections.$inferSelect> = []

			if (type && type !== 'built-in' && tables?.length && effectiveConnectionString) {
				const mode =
					accessMode ||
					(savedExternalDb.accessMode as 'read-write' | 'read-only' | undefined) ||
					'read-write'

				// Test write permissions if read-write requested
				let effectiveMode = mode
				if (mode === 'read-write') {
					try {
						const adapter = createExternalDbAdapter({
							type,
							connectionString: effectiveConnectionString,
							database: effectiveDatabase || undefined,
						})
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
					const [existing] = await app.db
						.select({ id: collections.id })
						.from(collections)
						.where(
							and(
								eq(collections.name, table.name),
								eq(collections.projectId, getProject(request).id),
							),
						)
						.limit(1)

					// Map column types to field types. MongoDB scan columns already carry a
					// resolved CollectionField type; SQL columns carry a raw data_type string.
					const fields = table.columns
						.filter((c) => c.name !== '_id' && c.name !== 'id')
						.map((c) => ({
							name: c.name,
							type: (FIELD_TYPES.has(c.type)
								? c.type
								: mapColumnType(c.type)) as CollectionField['type'],
							required: false,
							localized: false,
							...(c.relationTo && { relationTo: c.relationTo }),
							...(c.relationIsArray && { relationIsArray: true }),
						}))

					// Collection already imported — refresh its detected field schema so
					// re-running the wizard upgrades types (e.g. text → relation/date).
					if (existing) {
						const [refreshed] = await app.db
							.update(collections)
							.set({ fields, updatedAt: new Date() })
							.where(eq(collections.id, existing.id))
							.returning()
						if (refreshed) cacheTargets.push(refreshed)
						continue
					}

					const [created] = await app.db
						.insert(collections)
						.values({
							projectId: getProject(request).id,
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
					cacheTargets.push(created)
				}

				// Warn about relations to collections that were not imported.
				const selectedNames = new Set(tables.map((t) => t.name))
				const missingRelations = new Map<string, Set<string>>()
				for (const table of tables) {
					for (const col of table.columns) {
						if (col.relationTo && !selectedNames.has(col.relationTo)) {
							let relations = missingRelations.get(table.name)
							if (!relations) {
								relations = new Set()
								missingRelations.set(table.name, relations)
							}
							relations.add(col.relationTo)
						}
					}
				}
				for (const [tableName, targets] of missingRelations) {
					warnings.push(
						`"${tableName}" references ${[...targets].join(', ')} which ${targets.size === 1 ? 'was' : 'were'} not imported. Relation fields pointing to ${targets.size === 1 ? 'it' : 'them'} will not be editable.`,
					)
				}

				// Populate markdown cache if DB is small enough
				const cacheLimitMb =
					Number(process.env.EXTERNAL_DB_CACHE_LIMIT_MB) ||
					((settings.externalDb as Record<string, unknown>)?.cacheLimitMb as number) ||
					100
				const cacheLimitBytes = cacheLimitMb * 1024 * 1024

				if (cacheTargets.length > 0) {
					try {
						const adapter = createExternalDbAdapter({
							type,
							connectionString: effectiveConnectionString,
							database: effectiveDatabase || undefined,
						})
						await adapter.connect()

						// Size the *selected* collections only — not the whole database.
						let selectedSizeBytes = 0
						for (const col of cacheTargets) {
							if (col.externalTable) {
								selectedSizeBytes += await adapter.estimateTableSizeBytes(col.externalTable)
							}
						}

						if (selectedSizeBytes <= cacheLimitBytes) {
							for (const col of cacheTargets) {
								if (col.externalTable) {
									await populateMarkdownCache(
										app.db,
										content,
										adapter,
										{
											id: col.id,
											projectId: col.projectId,
											externalTable: col.externalTable,
											fields: col.fields,
										},
										{ userId: request.user?.id },
									)
								}
							}
						} else {
							const sizeMb = Math.round(selectedSizeBytes / 1024 / 1024)
							warnings.push(
								`Selected collections total ${sizeMb} MB (limit: ${cacheLimitMb} MB). Content will be cached on demand.`,
							)
						}

						await adapter.disconnect()
					} catch (err) {
						warnings.push(
							`Cache population failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
						)
					}
				}
			}

			return {
				project: sanitizeProject(updated),
				collections: createdCollections,
				warnings: warnings.length > 0 ? warnings : undefined,
			}
		},
	)

	// Update only the per-table media-storage config for the connected external DB.
	// Lets users configure where an imported media library's files live without
	// re-running the whole import wizard.
	app.put<{ Params: { id: string } }>(
		'/:id/database/media-storage',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { mediaStorage } =
				(request.body as {
					mediaStorage?: Record<string, Record<string, unknown>>
				}) || {}

			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			if (!project) return reply.status(404).send({ error: 'Project not found' })

			const settings = (project.settings as unknown as Record<string, unknown>) || {}
			const externalDb = settings.externalDb as Record<string, unknown> | undefined
			if (!externalDb) {
				return reply.status(400).send({ error: 'No external database is connected' })
			}

			// Merge: when the client omits `credentials` for a table (they are never sent
			// back to the browser), keep whatever is already stored.
			const prevMap = (externalDb.mediaStorage || {}) as Record<string, Record<string, unknown>>
			let nextMap: Record<string, Record<string, unknown>> | undefined
			if (mediaStorage && Object.keys(mediaStorage).length > 0) {
				nextMap = {}
				for (const [table, entry] of Object.entries(mediaStorage)) {
					const incoming = { ...entry }
					const creds = incoming.credentials as Record<string, unknown> | undefined
					if (!creds || Object.keys(creds).length === 0) {
						const prevCreds = prevMap[table]?.credentials
						if (prevCreds) incoming.credentials = prevCreds
						else delete incoming.credentials
					}
					nextMap[table] = incoming
				}
			}
			externalDb.mediaStorage = nextMap

			const [updated] = await app.db
				.update(projects)
				.set({
					settings: settings as unknown as (typeof projects.$inferInsert)['settings'],
					updatedAt: new Date(),
				})
				.where(eq(projects.id, getProject(request).id))
				.returning()

			return { project: sanitizeProject(updated) }
		},
	)

	// Probe a sample of an imported media library's files to detect whether they are
	// publicly fetchable or require signed/credentialed access.
	app.post<{ Params: { id: string } }>(
		'/:id/database/media-probe',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { collectionName, table, type, connectionString, database, pathColumn, baseUrl } =
				(request.body as {
					collectionName?: string
					table?: string
					type?: string
					connectionString?: string
					database?: string
					pathColumn?: string
					baseUrl?: string
				}) || {}
			if (!pathColumn) {
				return reply.status(400).send({ error: 'pathColumn is required' })
			}
			const pid = getProject(request).id
			const values: string[] = []

			if (collectionName) {
				// Post-import: sample the local content cache of an imported collection.
				const [col] = await app.db
					.select()
					.from(collections)
					.where(and(eq(collections.name, collectionName), eq(collections.projectId, pid)))
					.limit(1)
				if (!col) return reply.status(404).send({ error: 'Collection not found' })
				const rows = await app.db
					.select()
					.from(content)
					.where(and(eq(content.projectId, pid), eq(content.collectionId, col.id)))
					.limit(8)
				for (const row of rows) {
					const v = (row.metadata as Record<string, unknown> | null)?.[pathColumn]
					if (typeof v === 'string' && v.trim()) values.push(v.trim())
				}
				if (values.length === 0) {
					return {
						result: 'inconclusive',
						detail:
							'No cached rows with a value in this path column. Sync the collection first, then retry.',
					}
				}
			} else if (table) {
				// Wizard-time: sample rows live from the external database before import.
				const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
				const saved = project ? getSavedExternalDb(project) : {}
				const connStr = connectionString || (saved.connectionString as string | undefined)
				const dbType = type || (saved.type as string | undefined)
				if (!connStr || !dbType) {
					return reply.status(400).send({ error: 'Connection details are required to probe' })
				}
				const ssrfError = await validateConnectionString(connStr)
				if (ssrfError) return reply.status(400).send({ error: ssrfError })
				const adapter = createExternalDbAdapter({
					type: dbType,
					connectionString: connStr,
					database: database || (saved.database as string | undefined),
				})
				await adapter.connect()
				try {
					const docs = await adapter.findAll(table, { limit: 8, offset: 0 })
					for (const doc of docs) {
						const v = (doc as Record<string, unknown>)[pathColumn]
						if (typeof v === 'string' && v.trim()) values.push(v.trim())
					}
				} finally {
					await adapter.disconnect()
				}
				if (values.length === 0) {
					return {
						result: 'inconclusive',
						detail: 'No rows with a value in this path column to sample.',
					}
				}
			} else {
				return reply.status(400).send({ error: 'collectionName or table is required' })
			}

			let probed = 0
			let publicHits = 0
			let privateHits = 0
			let skippedRelative = 0
			let sampleUrl: string | undefined
			for (const value of values.slice(0, 5)) {
				let url: string | null = null
				if (/^https?:\/\//i.test(value)) url = value
				else if (baseUrl?.trim())
					url = `${baseUrl.trim().replace(/\/$/, '')}/${value.replace(/^\//, '')}`
				if (!url) {
					skippedRelative++
					continue
				}
				// SSRF guard: never probe private/internal hosts.
				if (await validateConnectionString(url)) continue
				sampleUrl = sampleUrl || url
				try {
					const ctrl = new AbortController()
					const timer = setTimeout(() => ctrl.abort(), 8000)
					const res = await fetch(url, {
						method: 'GET',
						headers: { Range: 'bytes=0-0' },
						redirect: 'follow',
						signal: ctrl.signal,
					})
					clearTimeout(timer)
					probed++
					if (res.status === 200 || res.status === 206) publicHits++
					else if (res.status === 401 || res.status === 403) privateHits++
				} catch {
					// network error — inconclusive for this sample
				}
			}

			let result: 'public' | 'private' | 'inconclusive' | 'need-base-url' = 'inconclusive'
			if (probed === 0 && skippedRelative > 0) {
				return {
					result: 'need-base-url',
					detail: 'Paths are relative — provide a public base URL to probe access.',
				}
			}
			if (publicHits > 0 && privateHits === 0) result = 'public'
			else if (privateHits > 0) result = 'private'

			return { result, probed, publicHits, privateHits, sampleUrl }
		},
	)
}
