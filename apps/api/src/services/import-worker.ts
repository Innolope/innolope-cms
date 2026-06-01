import { collections, content, importJobs, projects } from '@innolope/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { createExternalDbAdapter } from '../adapters/external-db.js'
import { detectEnumFields } from './enum-detection.js'
import { cacheMissingDocs } from './markdown-cache.js'

const BATCH_SIZE = 100
const POLL_INTERVAL_MS = 5_000

type ImportJob = typeof importJobs.$inferSelect

function getExternalDbConfig(project: typeof projects.$inferSelect | undefined) {
	const extDb = (project?.settings as unknown as Record<string, unknown>)?.externalDb as
		| Record<string, unknown>
		| undefined
	if (!extDb?.type || !extDb?.connectionString) return null
	return {
		type: extDb.type as string,
		connectionString: extDb.connectionString as string,
		database: extDb.database as string | undefined,
	}
}

/**
 * Background worker that fills the local `content` cache from external
 * collections. One job runs at a time; a job interrupted by a restart resumes
 * from its stored `processed` offset on the next tick.
 */
export function initImportWorker(app: FastifyInstance) {
	if (!app.db) return

	let processing = false
	const interval = setInterval(async () => {
		if (processing) return
		processing = true
		try {
			await drainQueue(app)
		} catch (err) {
			app.log.error(err, 'Import worker error')
		} finally {
			processing = false
		}
	}, POLL_INTERVAL_MS)

	app.addHook('onClose', () => clearInterval(interval))
}

/** Process queued jobs back-to-back until none remain. */
async function drainQueue(app: FastifyInstance) {
	while (true) {
		const [job] = await app.db
			.select()
			.from(importJobs)
			.where(inArray(importJobs.status, ['pending', 'running']))
			.orderBy(asc(importJobs.createdAt))
			.limit(1)
		if (!job) return
		await runJob(app, job)
	}
}

async function runJob(app: FastifyInstance, job: ImportJob) {
	const now = new Date()
	await app.db
		.update(importJobs)
		.set({ status: 'running', startedAt: job.startedAt ?? now, updatedAt: now })
		.where(eq(importJobs.id, job.id))

	try {
		const [collection] = await app.db
			.select()
			.from(collections)
			.where(and(eq(collections.id, job.collectionId), eq(collections.projectId, job.projectId)))
			.limit(1)
		if (!collection?.externalTable) {
			throw new Error('Collection no longer exists or is not backed by an external table')
		}

		const [project] = await app.db
			.select()
			.from(projects)
			.where(eq(projects.id, job.projectId))
			.limit(1)
		const extDb = getExternalDbConfig(project)
		if (!extDb) throw new Error('External database is not configured for this project')

		const adapter = createExternalDbAdapter(extDb)
		await adapter.connect()
		try {
			const total = job.total ?? (await adapter.count(collection.externalTable))
			if (job.total == null) {
				await app.db
					.update(importJobs)
					.set({ total, updatedAt: new Date() })
					.where(eq(importJobs.id, job.id))
			}

			let processed = job.processed
			let checkpoint: string | undefined = job.checkpoint ?? undefined
			for await (const docs of adapter.streamAll(collection.externalTable, {
				batchSize: BATCH_SIZE,
				startAfterId: checkpoint,
			})) {
				if (docs.length === 0) continue

				await cacheMissingDocs(
					app.db,
					content,
					docs,
					{ id: collection.id, projectId: collection.projectId, fields: collection.fields || [] },
					{ userId: job.createdBy ?? undefined },
				)

				processed += docs.length
				checkpoint = docs[docs.length - 1]._id
				// cacheMissingDocs is idempotent (onConflictDoNothing on slug), so a
				// crash between this insert and the checkpoint commit just re-runs
				// the same batch on restart — no duplicate rows, no skipped ones.
				await app.db
					.update(importJobs)
					.set({ processed, checkpoint, updatedAt: new Date() })
					.where(eq(importJobs.id, job.id))
			}
		} finally {
			await adapter.disconnect()
		}

		// Cached content is now local — upgrade low-cardinality text fields to
		// enum so they edit as dropdowns.
		const detected = await detectEnumFields(app.db, content, collection.id, collection.fields || [])
		if (detected !== collection.fields) {
			await app.db
				.update(collections)
				.set({ fields: detected, updatedAt: new Date() })
				.where(eq(collections.id, collection.id))
		}

		const done = new Date()
		await app.db
			.update(importJobs)
			.set({ status: 'completed', completedAt: done, updatedAt: done })
			.where(eq(importJobs.id, job.id))
	} catch (err) {
		const message = describeImportError(err)
		app.log.error(err, `Import job ${job.id} failed`)
		await app.db
			.update(importJobs)
			.set({ status: 'failed', error: message, updatedAt: new Date() })
			.where(eq(importJobs.id, job.id))
	}
}

/**
 * A failed bulk insert throws a Drizzle `DrizzleQueryError`, whose `.message` is
 * the entire SQL statement plus every bind parameter (100 rows × 12 cols per
 * batch — ~100 KB) while the real Postgres failure lives on `.cause`. Storing
 * `.message` both buried the actual reason and rendered an unusable blob in the
 * admin UI, so unwrap the cause and cap the length.
 */
function describeImportError(err: unknown): string {
	const MAX = 500
	const cause =
		err && typeof err === 'object' && 'cause' in err
			? (err as { cause?: unknown }).cause
			: undefined
	const root = cause ?? err
	let message: string
	if (root && typeof root === 'object') {
		const e = root as { message?: string; code?: string; detail?: string }
		message =
			[e.code ? `[${e.code}]` : null, e.message, e.detail].filter(Boolean).join(' ').trim() ||
			'Unknown error'
	} else {
		message = err instanceof Error ? err.message : 'Unknown error'
	}
	return message.length > MAX ? `${message.slice(0, MAX)}…` : message
}
