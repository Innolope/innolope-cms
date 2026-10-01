import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	contentVersions,
	externalSyncState,
	importJobs,
	projects,
} from '@innolope/db'
import { and, asc, eq, inArray, isNull, lte, notExists, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { createExternalDbAdapter } from '../adapters/external-db.js'
import { syncMarkdownCache } from './markdown-cache.js'

const DEFAULT_INTERVAL_MS = 10_000
const LEASE_MS = 90_000
const RENEW_MS = 30_000
const CONCURRENCY = 3

export function externalSyncIntervalMs(): number {
	const configured = Number(process.env.EXTERNAL_SYNC_INTERVAL_MS?.trim() || DEFAULT_INTERVAL_MS)
	return configured === 0 ||
		(Number.isSafeInteger(configured) && configured >= 1000 && configured <= 2_147_483_647)
		? configured
		: DEFAULT_INTERVAL_MS
}

export function externalSyncConfig(settings: unknown) {
	const source = (settings as { externalDb?: Record<string, unknown> } | null)?.externalDb
	if (
		typeof source?.type !== 'string' ||
		typeof source.connectionString !== 'string' ||
		!source.connectionString
	)
		return null
	return {
		type: source.type,
		connectionString: source.connectionString,
		database: typeof source.database === 'string' ? source.database : undefined,
	}
}

/** A single collection scan, shared by the scheduler and the manual Sync action. */
export async function syncExternalCollection(
	app: FastifyInstance,
	collection: typeof collections.$inferSelect,
	config: NonNullable<ReturnType<typeof externalSyncConfig>>,
	options: {
		background?: boolean
		userId?: string
		resolutions?: Record<string, { token: string; choice: 'local' | 'external' }>
		signal?: AbortSignal
	} = {},
) {
	await app.db
		.insert(externalSyncState)
		.values({ collectionId: collection.id })
		.onConflictDoNothing()
	const started = new Date()
	const token = randomUUID()
	const intervalMs = externalSyncIntervalMs() || DEFAULT_INTERVAL_MS
	const [lease] = await app.db
		.update(externalSyncState)
		.set({
			leaseToken: token,
			leaseUntil: new Date(started.getTime() + LEASE_MS),
			lastAttemptAt: started,
			nextAttemptAt: new Date(started.getTime() + intervalMs),
		})
		.where(
			and(
				eq(externalSyncState.collectionId, collection.id),
				or(isNull(externalSyncState.leaseUntil), lte(externalSyncState.leaseUntil, started)),
				...(options.background ? [lte(externalSyncState.nextAttemptAt, started)] : []),
			),
		)
		.returning()
	if (!lease) return null

	const controller = new AbortController()
	const abort = () => controller.abort()
	options.signal?.addEventListener('abort', abort, { once: true })
	if (options.signal?.aborted) controller.abort()
	const ownsLease = () =>
		and(eq(externalSyncState.collectionId, collection.id), eq(externalSyncState.leaseToken, token))
	let renewing = false
	const heartbeat = setInterval(async () => {
		if (renewing) return
		renewing = true
		try {
			const renewed = await app.db
				.update(externalSyncState)
				.set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
				.where(ownsLease())
				.returning({ id: externalSyncState.collectionId })
			if (renewed.length === 0) controller.abort()
		} catch {
			controller.abort()
		} finally {
			renewing = false
		}
	}, RENEW_MS)
	let adapter: ReturnType<typeof createExternalDbAdapter> | undefined
	try {
		controller.signal.throwIfAborted()
		adapter = createExternalDbAdapter(config)
		await adapter.connect()
		// Re-read the collection after claiming its lease: a preceding manual run
		// may have moved its cursor while this worker was waiting.
		const [current] = await app.db
			.select()
			.from(collections)
			.where(eq(collections.id, collection.id))
			.limit(1)
		if (!current?.externalTable) throw new Error('External collection no longer exists')
		const result = await syncMarkdownCache(
			app.db,
			content,
			adapter,
			{
				...current,
				externalTable: current.externalTable,
				// Source applications may change counters without maintaining updatedAt.
				// Full scans also keep previously detected conflicts available for review.
				lastSyncedCursor: null,
			},
			{
				userId: options.userId,
				resolutions: options.resolutions,
				versionTable: contentVersions,
				collectionsTable: collections,
				signal: controller.signal,
			},
		)
		controller.signal.throwIfAborted()
		await app.db
			.update(externalSyncState)
			.set({ conflicts: result.conflicts, lastError: null, failureCount: 0 })
			.where(ownsLease())
		return result
	} catch (err) {
		if (!controller.signal.aborted) {
			const failures = lease.failureCount + 1
			await app.db
				.update(externalSyncState)
				.set({
					lastError: 'Sync could not finish. It will retry automatically.',
					failureCount: failures,
					nextAttemptAt: new Date(
						Date.now() + Math.min(intervalMs * 2 ** Math.min(failures, 5), 300_000),
					),
				})
				.where(ownsLease())
		}
		throw err
	} finally {
		clearInterval(heartbeat)
		options.signal?.removeEventListener('abort', abort)
		try {
			await adapter?.disconnect()
		} finally {
			await app.db
				.update(externalSyncState)
				.set({ leaseToken: null, leaseUntil: null })
				.where(ownsLease())
		}
	}
}

/** Scan each configured external collection, skipping initial imports and active/due leases. */
export async function syncExternalCollections(app: FastifyInstance, signal?: AbortSignal) {
	const rows = await app.db
		.select({ collection: collections, settings: projects.settings })
		.from(collections)
		.innerJoin(projects, eq(projects.id, collections.projectId))
		.leftJoin(externalSyncState, eq(externalSyncState.collectionId, collections.id))
		.where(
			and(
				eq(collections.source, 'external'),
				or(
					isNull(externalSyncState.nextAttemptAt),
					lte(externalSyncState.nextAttemptAt, new Date()),
				),
				or(isNull(externalSyncState.leaseUntil), lte(externalSyncState.leaseUntil, new Date())),
				notExists(
					app.db
						.select({ id: importJobs.id })
						.from(importJobs)
						.where(
							and(
								eq(importJobs.collectionId, collections.id),
								inArray(importJobs.status, ['pending', 'running']),
							),
						),
				),
			),
		)
		.orderBy(asc(collections.id))
	let offset = 0
	const run = async () => {
		while (!signal?.aborted) {
			const row = rows[offset++]
			if (!row) return
			const config = externalSyncConfig(row.settings)
			if (!row.collection.externalTable || !config) continue
			try {
				await syncExternalCollection(app, row.collection, config, { background: true, signal })
			} catch (err) {
				if (!signal?.aborted)
					app.log.warn({ err, collectionId: row.collection.id }, 'Automatic external sync failed')
			}
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, run))
}

/** Always-on server scheduler: no browser or cron configuration required. */
export function initExternalSyncWorker(app: FastifyInstance) {
	const intervalMs = externalSyncIntervalMs()
	if (!app.db || !intervalMs || process.env.NODE_ENV === 'test') return
	const controller = new AbortController()
	let running: Promise<void> | null = null
	const timer = setInterval(() => {
		if (running) return
		running = syncExternalCollections(app, controller.signal)
			.catch((err) => app.log.error(err, 'Automatic external sync worker error'))
			.finally(() => {
				running = null
			})
	}, intervalMs)
	timer.unref()
	app.log.info({ intervalMs }, 'Automatic external sync enabled')
	app.addHook('onClose', async () => {
		clearInterval(timer)
		controller.abort()
		await running
	})
}
