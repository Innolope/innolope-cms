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
			while (true) {
				const docs = await adapter.findAll(collection.externalTable, {
					limit: BATCH_SIZE,
					offset: processed,
				})
				if (docs.length === 0) break

				await cacheMissingDocs(
					app.db,
					content,
					docs,
					{ id: collection.id, projectId: collection.projectId, fields: collection.fields || [] },
					{ userId: job.createdBy ?? undefined },
				)

				processed += docs.length
				await app.db
					.update(importJobs)
					.set({ processed, updatedAt: new Date() })
					.where(eq(importJobs.id, job.id))

				if (docs.length < BATCH_SIZE) break
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
		const message = err instanceof Error ? err.message : 'Unknown error'
		app.log.error(err, `Import job ${job.id} failed`)
		await app.db
			.update(importJobs)
			.set({ status: 'failed', error: message, updatedAt: new Date() })
			.where(eq(importJobs.id, job.id))
	}
}
