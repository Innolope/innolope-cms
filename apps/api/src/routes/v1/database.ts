import { randomUUID } from 'node:crypto'
import type { CollectionField } from '@innolope/config'
import { collections, content, importJobs, projects } from '@innolope/db'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import {
	parseFirebaseCredentials,
	validateConnectionString,
} from '../../adapters/connection-guard.js'
import { createExternalDbAdapter } from '../../adapters/external-db.js'
import {
	buildSubField,
	classifyMongoValue,
	detectMongoArrayShapes,
	detectMongoLocales,
	type ObjectArrayShape,
} from '../../adapters/mongo-introspect.js'
import { mapColumnType, tableNameToLabel } from '../../adapters/type-mapper.js'
import { getImageDimensions, isRejectedImageMime } from '../../lib/image.js'
import {
	conformsToSiteConvention,
	customerVisibleUrl,
	lintMediaValue,
	type MediaHealthRow,
	summarizeMediaHealth,
} from '../../lib/media-health.js'
import { detectMediaPathFormat } from '../../lib/media-path-format.js'
import { getMediaStorageMap, resolveMediaValue } from '../../lib/media-storage.js'
import {
	dedupeFilename,
	isDuplicateKeyError,
	isWritableImportedStorage,
	uploadToImportedStorage,
} from '../../lib/media-upload.js'
import { getUser } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'

/** Best-guess the media host (`r2` | `cloudflare-images` | `s3` | `cloudinary`) from a sample URL. */
function detectProvider(url: string | undefined): string | undefined {
	if (!url) return undefined
	let host: string
	try {
		host = new URL(url).hostname.toLowerCase()
	} catch {
		return undefined
	}
	if (host === 'imagedelivery.net' || host.endsWith('.imagedelivery.net'))
		return 'cloudflare-images'
	if (host.endsWith('.r2.dev') || host.endsWith('.r2.cloudflarestorage.com')) return 'r2'
	if (host.endsWith('.cloudinary.com')) return 'cloudinary'
	if (host.includes('.s3.') || host === 's3.amazonaws.com' || host.endsWith('.amazonaws.com'))
		return 's3'
	return undefined
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

	// Import progress for the project's external-DB import jobs. Lets an MCP agent
	// (or the UI) poll until a configured import finishes. Returns per-collection
	// job rows plus an aggregate summary.
	app.get<{ Params: { id: string } }>(
		'/:id/database/import-status',
		{ preHandler: [app.requireProject('viewer')] },
		async (request) => {
			const jobs = await app.db
				.select({
					collectionId: importJobs.collectionId,
					collectionName: collections.name,
					externalTable: importJobs.externalTable,
					status: importJobs.status,
					total: importJobs.total,
					processed: importJobs.processed,
					error: importJobs.error,
					startedAt: importJobs.startedAt,
					completedAt: importJobs.completedAt,
				})
				.from(importJobs)
				.leftJoin(collections, eq(collections.id, importJobs.collectionId))
				.where(eq(importJobs.projectId, getProject(request).id))

			const summary = {
				total: jobs.length,
				pending: jobs.filter((j) => j.status === 'pending').length,
				running: jobs.filter((j) => j.status === 'running').length,
				completed: jobs.filter((j) => j.status === 'completed').length,
				failed: jobs.filter((j) => j.status === 'failed').length,
			}
			return { summary, jobs }
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
			const { type, connectionString, database, tables, accessMode, mediaStorage, visibleTables } =
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
					// Names of tables the user *explicitly* selected in the wizard, as opposed to
					// relation targets the client auto-includes to keep relation fields editable.
					// Explicit picks get `sidebarMode: 'show'` so a selected collection always
					// appears in the sidebar; auto-pulled targets stay on `auto` (hidden when
					// another collection references them). Absent ⇒ leave visibility untouched.
					visibleTables?: string[]
				}

			// When the client sends the explicit selection, the wizard becomes the source of
			// truth for sidebar visibility.
			const hasVisibilitySignal = Array.isArray(visibleTables)
			const visibleTableSet = new Set(visibleTables ?? [])

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

				// Learn how each media library already stores its paths, so files we
				// upload later are written in the same shape. The customer's own site
				// reads that column directly and never sees our read-side resolution, so
				// a mismatch renders as a broken image on their pages, not here.
				//
				// Detection never overwrites a recorded format. A confident sample fills
				// an unset one; a disagreeing or ambiguous sample is parked in
				// `formatDrift` and surfaced as a warning for a human to resolve.
				const storageMap = (settings.externalDb as Record<string, unknown>).mediaStorage as
					| Record<string, Record<string, unknown>>
					| undefined
				if (storageMap && effectiveConnectionString) {
					for (const [table, entry] of Object.entries(storageMap)) {
						if (!entry || typeof entry !== 'object') continue
						const pathColumn = entry.pathColumn as string | undefined
						if (!pathColumn) continue
						try {
							const adapter = createExternalDbAdapter({
								type: type as string,
								connectionString: effectiveConnectionString,
								database: effectiveDatabase || undefined,
							})
							await adapter.connect()
							let samples: string[] = []
							try {
								const docs = await adapter.findAll(table, { limit: 50, offset: 0 })
								samples = docs
									.map((doc) => (doc as Record<string, unknown>)[pathColumn])
									.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
							} finally {
								await adapter.disconnect()
							}
							const detected = detectMediaPathFormat(samples)
							if (!detected) continue
							const now = new Date().toISOString()
							const recorded = entry.pathFormat as string | undefined

							if (recorded) {
								const agrees =
									detected.format === recorded &&
									(!entry.pathVariant ||
										!detected.variant ||
										detected.variant === entry.pathVariant)
								if (agrees) {
									if (entry.formatSource !== 'user') {
										entry.formatSource = entry.formatSource || 'detected'
										entry.formatConfidence = detected.confidence
										entry.formatSampled = detected.sampled
										entry.formatDetectedAt = now
									}
									delete entry.formatDrift
								} else {
									entry.formatDrift = {
										format: detected.format,
										variant: detected.variant,
										confidence: detected.confidence,
										detectedAt: now,
									}
									warnings.push(
										`"${table}" is configured to store media paths as ${recorded}, but a fresh sample looks like ${detected.format} (${Math.round(detected.confidence * 100)}% of ${detected.sampled} rows). Review it under Imported media storage.`,
									)
								}
								continue
							}

							if (detected.mixed) {
								// Not trusted enough to commit: without a recorded format the
								// write path falls back to storing a complete URL, which
								// resolves everywhere even if it isn't the library's shape.
								entry.formatDrift = {
									format: detected.format,
									variant: detected.variant,
									confidence: detected.confidence,
									detectedAt: now,
								}
								warnings.push(
									`"${table}" stores media paths in mixed shapes — the most common is ${detected.format} (${detected.matched} of ${detected.sampled} sampled rows). Pick the format under Imported media storage; until then new uploads store a complete URL.`,
								)
								continue
							}

							entry.pathFormat = detected.format
							const variant = detected.variant || detected.suggestedVariant
							if (variant && !entry.pathVariant) entry.pathVariant = variant
							entry.formatSource = 'detected'
							entry.formatConfidence = detected.confidence
							entry.formatSampled = detected.sampled
							entry.formatDetectedAt = now
							delete entry.formatDrift
							warnings.push(
								`"${table}" stores media paths as ${detected.format}${
									variant ? ` (variant "${variant}")` : ''
								} — matched ${detected.matched} of ${detected.sampled} sampled rows. New uploads will use this shape; change it under Imported media storage.`,
							)
						} catch (err) {
							app.log.warn({ err, table }, 'Media path-format detection failed')
						}
					}
				}
			}

			// Auto-detect localized content. When the external DB is MongoDB and one or
			// more selected collections store their text fields as `{ <locale>: string }`
			// objects (the convention used by this CMS), union those locale codes into
			// `settings.locales` so the editor's dual-mode/translate UI lights up
			// without requiring the admin to manually edit "Available locales".
			// Bounded work: sample at most 20 docs per selected collection.
			if (
				type === 'mongodb' &&
				effectiveConnectionString &&
				Array.isArray(tables) &&
				tables.length > 0
			) {
				try {
					const detected = await detectMongoLocales(
						effectiveConnectionString,
						effectiveDatabase || undefined,
						tables.map((t) => t.name),
					)
					if (detected.length > 0) {
						const existing = Array.isArray(settings.locales)
							? (settings.locales as string[])
							: ['en']
						const merged: string[] = []
						const seen = new Set<string>()
						for (const code of [...existing, ...detected]) {
							if (!seen.has(code)) {
								seen.add(code)
								merged.push(code)
							}
						}
						const added = merged.filter((c) => !existing.includes(c))
						if (added.length > 0) {
							settings.locales = merged
							warnings.push(
								`Detected ${added.length === 1 ? 'locale' : 'locales'} ${added.join(', ')} in your content. Added to project locales.`,
							)
						}
					}
				} catch (err) {
					app.log.warn({ err }, 'Locale auto-detection failed; leaving settings.locales as-is')
				}
			}

			// Detect array-of-object shapes so the editor renders structured rows
			// (e.g. `socialLinks: [{ platform, url }]`) instead of a flat pill input.
			// Computed up-front and consulted when building each collection's `fields`
			// below so existing collections also pick up shapes on re-sync.
			let arrayShapes: Map<string, Map<string, ObjectArrayShape>> = new Map()
			if (
				type === 'mongodb' &&
				effectiveConnectionString &&
				Array.isArray(tables) &&
				tables.length > 0
			) {
				try {
					arrayShapes = await detectMongoArrayShapes(
						effectiveConnectionString,
						effectiveDatabase || undefined,
						tables.map((t) => t.name),
					)
				} catch (err) {
					app.log.warn(
						{ err },
						'Array-shape auto-detection failed; arrays will use the generic widget',
					)
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
					// Only genuinely database-owned columns are marked read-only. Lifecycle
					// timestamps (createdAt/updatedAt/publishedAt) are deliberately NOT:
					// editors routinely need to backdate a post, and the site consuming the
					// source database usually renders `createdAt` as the published date. They
					// stay ordinary editable `date` fields; an admin who wants one locked can
					// tick Advanced → Read-only in the collection schema editor.
					const SYSTEM_FIELDS = new Set(['__v'])
					// `slug` is also kept out of the schema fields list — it's already
					// represented at the top level of every content row as `content.slug`,
					// and the editor renders a dedicated slug input. Letting it through
					// as a schema field produced a duplicate input AND a duplicate value
					// in the saved payload (top-level + metadata.slug).
					const tableShapes = arrayShapes.get(table.name)
					const fields = table.columns
						.filter((c) => c.name !== '_id' && c.name !== 'id' && c.name !== 'slug')
						.map((c) => {
							const isSystem = SYSTEM_FIELDS.has(c.name)
							const resolvedType = (
								FIELD_TYPES.has(c.type) ? c.type : mapColumnType(c.type)
							) as CollectionField['type']

							// Build the optional UI hint blob. Read-only (system fields)
							// and subFields (array-of-object shape) coexist when both
							// apply; the spread keeps the field shape compact when
							// neither does.
							let ui: { readOnly?: boolean; subFields?: CollectionField[] } | undefined
							if (isSystem) ui = { ...(ui ?? {}), readOnly: true }
							const shape = resolvedType === 'array' ? tableShapes?.get(c.name) : undefined
							if (shape && shape.keys.length > 0) {
								ui = {
									...(ui ?? {}),
									subFields: shape.keys.map((key) => buildSubField(key, shape)),
								}
							}

							return {
								name: c.name,
								type: resolvedType,
								required: false,
								localized: false,
								...(c.relationTo && { relationTo: c.relationTo }),
								...(c.relationIsArray && { relationIsArray: true }),
								...(ui && { ui }),
							}
						})

					// Collection already imported — refresh its detected field schema so
					// re-running the wizard upgrades types (e.g. text → relation/date).
					if (existing) {
						const [refreshed] = await app.db
							.update(collections)
							.set({
								fields,
								updatedAt: new Date(),
								// Re-selecting a table in the wizard re-asserts its visibility: an explicit
								// pick ⇒ show, an auto-pulled relation target ⇒ auto (hidden). No signal ⇒
								// leave whatever visibility the collection already has.
								...(hasVisibilitySignal
									? {
											sidebarMode: visibleTableSet.has(table.name)
												? ('show' as const)
												: ('auto' as const),
										}
									: {}),
							})
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
							// Explicitly-selected tables show in the sidebar; relation targets the
							// client auto-included stay on `auto` (hidden when referenced).
							sidebarMode: visibleTableSet.has(table.name) ? 'show' : 'auto',
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

				// The wizard's selection is authoritative for sidebar visibility: any
				// external collection the user left out this round is hidden. Kept, not
				// deleted, so its cached content survives if it's re-selected later.
				if (hasVisibilitySignal) {
					await app.db
						.update(collections)
						.set({ sidebarMode: 'hide', updatedAt: new Date() })
						.where(
							and(
								eq(collections.projectId, getProject(request).id),
								eq(collections.source, 'external'),
								notInArray(collections.name, [...selectedNames]),
							),
						)
				}

				// Queue a background import to fill the markdown cache, if the
				// selected collections are small enough to cache at all.
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
						await adapter.disconnect()

						if (selectedSizeBytes <= cacheLimitBytes) {
							// Enqueue one background import job per collection. The import
							// worker fills the cache; meanwhile the collection is browsable
							// live from the external DB.
							for (const col of cacheTargets) {
								if (!col.externalTable) continue
								const [activeJob] = await app.db
									.select({ id: importJobs.id })
									.from(importJobs)
									.where(
										and(
											eq(importJobs.collectionId, col.id),
											inArray(importJobs.status, ['pending', 'running']),
										),
									)
									.limit(1)
								if (activeJob) continue
								await app.db.insert(importJobs).values({
									projectId: col.projectId,
									collectionId: col.id,
									externalTable: col.externalTable,
									createdBy: request.user?.id ?? null,
								})
							}
						} else {
							const sizeMb = Math.round(selectedSizeBytes / 1024 / 1024)
							warnings.push(
								`Selected collections total ${sizeMb} MB (limit: ${cacheLimitMb} MB). Content will be served live from the external database instead of cached.`,
							)
						}
					} catch (err) {
						warnings.push(
							`Could not queue content import: ${err instanceof Error ? err.message : 'Unknown error'}`,
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
					// `hasCredentials` is a sanitized echo, not a setting.
					delete incoming.hasCredentials
					const creds = incoming.credentials as Record<string, unknown> | undefined
					if (!creds || Object.keys(creds).length === 0) {
						const prevCreds = prevMap[table]?.credentials
						if (prevCreds) incoming.credentials = prevCreds
						else delete incoming.credentials
					}
					// A changed format arriving through this endpoint is a human's
					// decision: record that so sync-time detection never overwrites it,
					// and clear any pending drift — the human has just ruled on it. An
					// unchanged format keeps its drift only if the client re-sent it
					// (resolving via Keep/Switch omits it).
					const prev = prevMap[table]
					if (incoming.pathFormat) {
						const changed =
							incoming.pathFormat !== prev?.pathFormat ||
							(incoming.pathVariant ?? '') !== (prev?.pathVariant ?? '')
						incoming.formatSource = changed
							? 'user'
							: incoming.formatSource || prev?.formatSource || 'user'
						if (changed) delete incoming.formatDrift
						if (incoming.formatDetectedAt == null && prev?.formatDetectedAt) {
							incoming.formatDetectedAt = prev.formatDetectedAt
						}
					}
					nextMap[table] = incoming
				}
			}
			externalDb.mediaStorage = nextMap

			// Auto-promote: if the wizard just attached a `cloudflare-images` library and
			// this project's native upload adapter is still the default (`local`), and the
			// server has the Cloudflare env vars set, also flip `mediaAdapter` to
			// `cloudflare` so new uploads via /v1/media/upload land in Cloudflare too.
			// Without this the wizard's "Cloudflare Images" choice silently applies only to
			// the imported library, while fresh uploads keep going to the local disk.
			let adapterPromoted = false
			const hasCloudflareImagesEntry = nextMap
				? Object.values(nextMap).some((entry) => entry.adapter === 'cloudflare-images')
				: false
			const currentAdapter = (settings.mediaAdapter as string | undefined) || 'local'
			const serverHasCfEnv = Boolean(
				process.env.CLOUDFLARE_ACCOUNT_ID &&
					process.env.CLOUDFLARE_API_TOKEN &&
					process.env.CLOUDFLARE_IMAGES_ACCOUNT_HASH,
			)
			if (hasCloudflareImagesEntry && currentAdapter === 'local' && serverHasCfEnv) {
				settings.mediaAdapter = 'cloudflare'
				adapterPromoted = true
			}

			const [updated] = await app.db
				.update(projects)
				.set({
					settings: settings as unknown as (typeof projects.$inferInsert)['settings'],
					updatedAt: new Date(),
				})
				.where(eq(projects.id, getProject(request).id))
				.returning()

			return { project: sanitizeProject(updated), adapterPromoted }
		},
	)

	// Probe a sample of an imported media library's files to detect whether they are
	// publicly fetchable or require signed/credentialed access.
	// Upload a new file into an imported media library's storage, then add a row
	// to the external collection (and the local cache) so it shows up immediately.
	app.post<{ Params: { id: string }; Querystring: { collectionId?: string } }>(
		'/:id/database/media-upload',
		{ preHandler: [app.requireProject('editor')] },
		async (request, reply) => {
			const collectionId = request.query.collectionId
			if (!collectionId) {
				return reply.status(400).send({ error: 'collectionId is required' })
			}
			const pid = getProject(request).id

			const [col] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, collectionId), eq(collections.projectId, pid)))
				.limit(1)
			if (!col) return reply.status(404).send({ error: 'Collection not found' })
			if (col.source !== 'external' || !col.externalTable) {
				return reply
					.status(400)
					.send({ error: 'This collection is not backed by an external table' })
			}
			if (col.accessMode === 'read-only') {
				return reply.status(403).send({ error: 'This collection is read-only' })
			}

			const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
			if (!project) return reply.status(404).send({ error: 'Project not found' })

			const entry = getMediaStorageMap(project)[col.externalTable]
			if (!entry) {
				return reply
					.status(400)
					.send({ error: 'No imported media storage is configured for this collection' })
			}
			if (!isWritableImportedStorage(entry)) {
				return reply
					.status(400)
					.send({ error: 'This media library uses public URLs and cannot receive uploads' })
			}

			const file = await request.file()
			if (!file) return reply.status(400).send({ error: 'No file provided' })
			if (isRejectedImageMime(file.mimetype)) {
				return reply.status(400).send({ error: `Unsupported image type: ${file.mimetype}.` })
			}
			let buffer: Buffer
			try {
				buffer = await file.toBuffer()
			} catch {
				return reply.status(400).send({ error: 'File exceeds the maximum upload size' })
			}
			if (file.file.truncated) {
				return reply.status(400).send({ error: 'File exceeds the maximum upload size' })
			}

			let uploaded: { key: string }
			try {
				uploaded = await uploadToImportedStorage(entry, buffer, file.filename, file.mimetype)
			} catch (err) {
				const status = (err as { statusCode?: number }).statusCode || 502
				return reply
					.status(status)
					.send({ error: err instanceof Error ? err.message : 'Upload failed' })
			}

			// Build the external row: the path column plus best-effort meta columns.
			const splitCamel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			const fieldNames = (col.fields || []).map((f) => f.name)
			const rowData: Record<string, unknown> = { [entry.pathColumn]: uploaded.key }
			const fillMeta = (re: RegExp, value: unknown) => {
				if (value == null) return
				const match = fieldNames.find(
					(n) => n !== entry.pathColumn && !(n in rowData) && re.test(splitCamel(n)),
				)
				if (match) rowData[match] = value
			}
			const dims = getImageDimensions(buffer)
			fillMeta(/(^|_)(mimetype|mime)($|_)/i, file.mimetype)
			fillMeta(/(^|_)(filename|name)($|_)/i, file.filename)
			fillMeta(/(^|_)(filesize|size)($|_)/i, buffer.length)
			if (dims) {
				fillMeta(/(^|_)width($|_)/i, dims.width)
				fillMeta(/(^|_)height($|_)/i, dims.height)
			}

			// Insert into the external table.
			const ext = getSavedExternalDb(project)
			let externalId: string | undefined
			const adapter = createExternalDbAdapter({
				type: ext.type as string,
				connectionString: ext.connectionString as string,
				database: (ext.database as string | undefined) || undefined,
			})
			await adapter.connect()
			try {
				let inserted: Awaited<ReturnType<typeof adapter.insert>>
				try {
					inserted = await adapter.insert(col.externalTable, rowData)
				} catch (err) {
					if (!isDuplicateKeyError(err)) throw err
					// The library has a unique index (typically on filename) and this
					// name already exists. De-duplicate the name columns and retry
					// once; a second collision means the conflict isn't on the name.
					for (const [key, value] of Object.entries(rowData)) {
						if (typeof value === 'string' && /(^|_)(filename|name)($|_)/i.test(splitCamel(key))) {
							rowData[key] = dedupeFilename(value)
						}
					}
					try {
						inserted = await adapter.insert(col.externalTable, rowData)
					} catch (retryErr) {
						if (isDuplicateKeyError(retryErr)) {
							return reply.status(409).send({
								error:
									'A file with this name already exists in this library. Pick the existing file instead of re-uploading, or rename the file.',
							})
						}
						throw retryErr
					}
				}
				externalId = (inserted as { _id?: string })?._id
			} finally {
				await adapter.disconnect()
			}

			// Cache locally so the new media appears immediately in the collection list.
			const base =
				file.filename
					.toLowerCase()
					.replace(/\.[^.]+$/, '')
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-+|-+$/g, '')
					.slice(0, 60) || 'media'
			const slug = `${base}-${randomUUID().slice(0, 8)}`
			const [created] = await app.db
				.insert(content)
				.values({
					projectId: pid,
					slug,
					collectionId: col.id,
					metadata: rowData,
					markdown: '',
					html: '',
					locale: 'en',
					status: 'published',
					createdBy: getUser(request).id,
					...(externalId && { externalId }),
				})
				.returning()

			return reply.status(201).send(created)
		},
	)

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
					.limit(50)
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
					const docs = await adapter.findAll(table, { limit: 50, offset: 0 })
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

			return {
				result,
				probed,
				publicHits,
				privateHits,
				sampleUrl,
				provider: detectProvider(sampleUrl),
				// How the source writes this column, so the settings UI can preselect
				// the matching option (and show why) instead of making the user guess.
				pathFormat: detectMediaPathFormat(values),
			}
		},
	)

	// Judge the RAW stored values of an imported media library exactly as the
	// customer's own site sees them. The CMS's read-side normalization can make a
	// broken value render fine in-app — this check exists to unmask that.
	app.post<{ Params: { id: string } }>(
		'/:id/database/media-health',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { collectionId, limit } =
				(request.body as { collectionId?: string; limit?: number }) || {}
			if (!collectionId) return reply.status(400).send({ error: 'collectionId is required' })
			const pid = getProject(request).id

			const [col] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, collectionId), eq(collections.projectId, pid)))
				.limit(1)
			if (!col) return reply.status(404).send({ error: 'Collection not found' })
			if (col.source !== 'external' || !col.externalTable) {
				return reply.status(400).send({ error: 'Not an imported collection' })
			}

			const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
			if (!project) return reply.status(404).send({ error: 'Project not found' })
			const entry = getMediaStorageMap(project)[col.externalTable]
			if (!entry?.pathColumn) {
				return reply.status(400).send({ error: 'This library has no media storage configured' })
			}
			const saved = getSavedExternalDb(project)
			const connStr = saved.connectionString as string | undefined
			const dbType = saved.type as string | undefined
			if (!connStr || !dbType) {
				return reply.status(400).send({ error: 'No external database connection is saved' })
			}
			const ssrfError = await validateConnectionString(connStr)
			if (ssrfError) return reply.status(400).send({ error: ssrfError })

			const sampleLimit = Math.min(Math.max(Number(limit) || 25, 1), 100)
			const adapter = createExternalDbAdapter({
				type: dbType,
				connectionString: connStr,
				database: (saved.database as string | undefined) || undefined,
			})
			await adapter.connect()
			let docs: Awaited<ReturnType<typeof adapter.findAll>>
			try {
				docs = await adapter.findAll(col.externalTable, { limit: sampleLimit, offset: 0 })
			} finally {
				await adapter.disconnect()
			}

			const checkRow = async (doc: (typeof docs)[number]): Promise<MediaHealthRow> => {
				const externalId = String(doc._id)
				const rawUnknown = doc[entry.pathColumn]
				if (typeof rawUnknown !== 'string' || !rawUnknown.trim()) {
					return {
						externalId,
						rawValue: typeof rawUnknown === 'string' ? rawUnknown : '',
						verdict: 'skipped',
						problems: ['empty-value'],
						repairable: false,
					}
				}
				const raw = rawUnknown.trim()

				// A value matching the library's own convention for a shape the site
				// completes itself (variant-less delivery URLs, bare ids, keys) is
				// healthy by definition — probing it as a plain URL would only
				// produce a false "broken on your site" for every native row.
				if (conformsToSiteConvention(raw, entry)) {
					return { externalId, rawValue: raw, verdict: 'ok', problems: [], repairable: true }
				}

				const lint = lintMediaValue(raw, entry)
				const problems = [...lint.problems]

				let url = customerVisibleUrl(raw, entry)
				let signedCheckOnly = false
				if (!url && entry.access === 'private' && entry.credentials) {
					const resolved = await resolveMediaValue(raw, entry)
					if (typeof resolved === 'string' && /^https?:\/\//i.test(resolved)) {
						url = resolved
						signedCheckOnly = true
					}
				}
				if (!url) {
					problems.push('not-probeable')
					return { externalId, rawValue: raw, verdict: 'skipped', problems, repairable: false }
				}
				if (await validateConnectionString(url)) {
					problems.push('unsafe-host')
					return { externalId, rawValue: raw, verdict: 'skipped', problems, repairable: false }
				}

				const probed = await probeMediaUrl(url)
				if (probed.ok) {
					return {
						externalId,
						rawValue: raw,
						verdict: 'ok',
						problems,
						repairable: true,
						signedCheckOnly: signedCheckOnly || undefined,
					}
				}
				problems.push(probed.status ? `http-${probed.status}` : 'network-error')

				// Broken raw value — does the CMS's normalization hide it?
				let masked = false
				if (!signedCheckOnly) {
					const normalized = await resolveMediaValue(raw, entry)
					if (
						typeof normalized === 'string' &&
						normalized !== url &&
						/^https?:\/\//i.test(normalized) &&
						!(await validateConnectionString(normalized))
					) {
						masked = (await probeMediaUrl(normalized)).ok
					}
				}
				if (masked) problems.push('masked-by-normalization')

				// Only offer a repair that demonstrably resolves.
				let suggestedFix: string | undefined
				if (lint.suggestedFix && !(await validateConnectionString(lint.suggestedFix))) {
					if ((await probeMediaUrl(lint.suggestedFix)).ok) suggestedFix = lint.suggestedFix
				}

				return {
					externalId,
					rawValue: raw,
					verdict: masked ? 'masked' : 'broken',
					problems,
					suggestedFix,
					repairable: lint.repairable && Boolean(suggestedFix),
					signedCheckOnly: signedCheckOnly || undefined,
				}
			}

			// Bounded concurrency: each row can cost several 8s-timeout probes.
			const rows: MediaHealthRow[] = []
			for (let i = 0; i < docs.length; i += 5) {
				rows.push(...(await Promise.all(docs.slice(i, i + 5).map(checkRow))))
			}

			return { rows, summary: summarizeMediaHealth(rows) }
		},
	)

	// Apply human-confirmed repairs to an imported media library. Every value is
	// re-verified over HTTP immediately before it is written to the customer's DB.
	app.post<{ Params: { id: string } }>(
		'/:id/database/media-health/fix',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { collectionId, rows, dryRun } =
				(request.body as {
					collectionId?: string
					rows?: Array<{ externalId: string; newValue: string }>
					dryRun?: boolean
				}) || {}
			if (!collectionId) return reply.status(400).send({ error: 'collectionId is required' })
			if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100) {
				return reply.status(400).send({ error: 'rows must contain 1–100 entries' })
			}
			const pid = getProject(request).id

			const [col] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, collectionId), eq(collections.projectId, pid)))
				.limit(1)
			if (!col) return reply.status(404).send({ error: 'Collection not found' })
			if (col.source !== 'external' || !col.externalTable) {
				return reply.status(400).send({ error: 'Not an imported collection' })
			}
			if (col.accessMode === 'read-only') {
				return reply
					.status(403)
					.send({ error: 'This collection is connected read-only — fixes cannot be written' })
			}

			const [project] = await app.db.select().from(projects).where(eq(projects.id, pid)).limit(1)
			if (!project) return reply.status(404).send({ error: 'Project not found' })
			const entry = getMediaStorageMap(project)[col.externalTable]
			if (!entry?.pathColumn) {
				return reply.status(400).send({ error: 'This library has no media storage configured' })
			}
			const saved = getSavedExternalDb(project)
			const connStr = saved.connectionString as string | undefined
			const dbType = saved.type as string | undefined
			if (!connStr || !dbType) {
				return reply.status(400).send({ error: 'No external database connection is saved' })
			}
			const ssrfError = await validateConnectionString(connStr)
			if (ssrfError) return reply.status(400).send({ error: ssrfError })

			const verifyValue = async (newValue: string): Promise<string | null> => {
				let url = customerVisibleUrl(newValue, entry)
				if (!url && entry.access === 'private' && entry.credentials) {
					const resolved = await resolveMediaValue(newValue, entry)
					if (typeof resolved === 'string' && /^https?:\/\//i.test(resolved)) url = resolved
				}
				if (!url) return 'The new value cannot be verified against a URL'
				if (await validateConnectionString(url)) return 'The new value resolves to a blocked host'
				if (!(await probeMediaUrl(url)).ok)
					return 'The new value does not resolve (HTTP check failed)'
				return null
			}

			const adapter = createExternalDbAdapter({
				type: dbType,
				connectionString: connStr,
				database: (saved.database as string | undefined) || undefined,
			})
			await adapter.connect()
			const results: Array<{ externalId: string; ok: boolean; error?: string }> = []
			try {
				for (const row of rows) {
					const newValue = typeof row.newValue === 'string' ? row.newValue.trim() : ''
					if (!row.externalId || !newValue) {
						results.push({ externalId: row.externalId ?? '', ok: false, error: 'Invalid row' })
						continue
					}
					const verifyError = await verifyValue(newValue)
					if (verifyError) {
						results.push({ externalId: row.externalId, ok: false, error: verifyError })
						continue
					}
					if (dryRun) {
						results.push({ externalId: row.externalId, ok: true })
						continue
					}
					try {
						await adapter.update(col.externalTable, row.externalId, {
							[entry.pathColumn]: newValue,
						})
						// Keep the local cache in step so the CMS shows the fixed value too.
						const [cached] = await app.db
							.select()
							.from(content)
							.where(
								and(
									eq(content.projectId, pid),
									eq(content.collectionId, col.id),
									eq(content.externalId, row.externalId),
								),
							)
							.limit(1)
						if (cached) {
							const metadata = { ...((cached.metadata as Record<string, unknown>) || {}) }
							metadata[entry.pathColumn] = newValue
							await app.db
								.update(content)
								.set({ metadata, updatedAt: new Date() })
								.where(eq(content.id, cached.id))
						}
						results.push({ externalId: row.externalId, ok: true })
					} catch (err) {
						results.push({
							externalId: row.externalId,
							ok: false,
							error: err instanceof Error ? err.message : 'Update failed',
						})
					}
				}
			} finally {
				await adapter.disconnect()
			}

			return {
				results,
				applied: dryRun ? 0 : results.filter((r) => r.ok).length,
				dryRun: Boolean(dryRun),
			}
		},
	)
}

/** GET the first byte of a URL to see whether it resolves; 8s timeout. */
async function probeMediaUrl(url: string): Promise<{ ok: boolean; status?: number }> {
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
		// Consume nothing: a Range request returns at most one byte anyway.
		await res.body?.cancel()
		return { ok: res.status === 200 || res.status === 206, status: res.status }
	} catch {
		return { ok: false }
	}
}
