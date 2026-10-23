import { randomUUID } from 'node:crypto'
import {
	collections,
	content,
	type IndexNowSettings,
	indexNowQueue,
	indexNowSubmissions,
	projects,
} from '@innolope/db'
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { validatePublicUrl } from '../adapters/connection-guard.js'
import type { CmsEvent } from '../plugins/events.js'
import {
	affectedUrls,
	checkUrlTemplate,
	INDEXNOW_MAX_ATTEMPTS,
	INDEXNOW_MAX_URLS_PER_REQUEST,
	keyLocationFor,
	recordUrls,
	retryDelayMs,
	submitToIndexNow,
	type UrlState,
	verifyKeyFile,
} from './indexnow.js'

/**
 * The IndexNow queue: content events put the public URLs they changed into
 * `indexnow_queue`, and a timer sends them in batches. Durable on purpose — a
 * deploy right after a publish must not lose the submission — and claimed with
 * a lease plus SKIP LOCKED, so several API instances never send a URL twice.
 *
 * Content events are the only feed, so every publish path (editor, bulk update,
 * bulk actions, approve, revert, scheduled publisher, MCP) is covered by the
 * events those paths already emit for webhooks.
 */

/** How long a claimed batch is reserved for the instance sending it. */
const LEASE_MS = 5 * 60_000
/** A batch held for a missing key file is checked again after this long. */
const KEY_RECHECK_MS = 5 * 60_000
/** Queued URLs older than this are given up (a key file that never appeared). */
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60_000
/** Submission log retention. */
const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000
/** URLs longer than this are skipped: the protocol and the unique index both choke on them. */
const MAX_URL_LENGTH = 2048
/** Groups sent per flush, and requests per group per flush. */
const MAX_GROUPS_PER_FLUSH = 50
const MAX_ROUNDS_PER_GROUP = 10

function envMs(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === '') return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Edits to a site within this window go out as one request. */
export function indexNowDebounceMs(): number {
	return envMs('INDEXNOW_DEBOUNCE_MS', 60_000)
}

function indexNowTickMs(): number {
	return envMs('INDEXNOW_TICK_MS', 15_000)
}

/** The project's IndexNow settings when they are usable, else null. */
export function readIndexNowSettings(projectSettings: unknown): IndexNowSettings | null {
	const value = (projectSettings as { indexNow?: Partial<IndexNowSettings> } | null)?.indexNow
	if (!value || typeof value.key !== 'string' || !value.key) return null
	return {
		enabled: value.enabled === true,
		key: value.key,
		keyLocation:
			typeof value.keyLocation === 'string' && value.keyLocation ? value.keyLocation : null,
	}
}

function projectLocales(projectSettings: unknown): string[] {
	const locales = (projectSettings as { locales?: unknown } | null)?.locales
	return Array.isArray(locales) ? locales.filter((l): l is string => typeof l === 'string') : []
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host.toLowerCase()
	} catch {
		return null
	}
}

// Enqueue work started by event listeners, so tests (and shutdown) can wait for it.
const inFlight = new Set<Promise<void>>()

export async function settleIndexNowEnqueues(): Promise<void> {
	while (inFlight.size > 0) await Promise.allSettled([...inFlight])
}

export function initIndexNow(app: FastifyInstance) {
	if (!app.db) return

	const unsubscribe = app.events.subscribe((event) => {
		if (!event.type.startsWith('content:')) return
		const work = enqueueContentEvent(app, event).catch((err) => {
			app.log.error(err, '[indexnow] could not queue the URLs of a content change')
		})
		inFlight.add(work)
		work.finally(() => inFlight.delete(work))
	})

	let interval: ReturnType<typeof setInterval> | null = null
	const tickMs = indexNowTickMs()
	if (tickMs > 0) {
		let running = false
		let lastCleanup = 0
		interval = setInterval(async () => {
			if (running) return
			running = true
			try {
				await flushIndexNowQueue(app)
				if (Date.now() - lastCleanup > 60 * 60_000) {
					lastCleanup = Date.now()
					await app.db
						.delete(indexNowSubmissions)
						.where(lt(indexNowSubmissions.createdAt, new Date(Date.now() - LOG_RETENTION_MS)))
				}
			} catch (err) {
				app.log.error(err, '[indexnow] flush failed')
			} finally {
				running = false
			}
		}, tickMs)
	}

	app.addHook('onClose', async () => {
		if (interval) clearInterval(interval)
		unsubscribe()
		await settleIndexNowEnqueues()
	})
}

/**
 * Turn one content event into queued URLs. Events carry the record's state
 * after the write (`status`, `slug`, `locale`) and before it (`previousStatus`,
 * `previousSlug`, `previousLocale`); an emitter that predates that shape is
 * covered by reading the row as it is now.
 */
async function enqueueContentEvent(app: FastifyInstance, event: CmsEvent): Promise<void> {
	const data = event.data
	const projectId = typeof data.projectId === 'string' ? data.projectId : null
	const id = typeof data.id === 'string' ? data.id : null
	if (!projectId || !id) return

	const [project] = await app.db
		.select({ settings: projects.settings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
	if (!project || !readIndexNowSettings(project.settings)?.enabled) return

	const deleted = event.type === 'content:deleted'
	let collectionId = typeof data.collectionId === 'string' ? data.collectionId : null
	let after: UrlState | null = null
	if (!deleted && (typeof data.status !== 'string' || !collectionId)) {
		const [row] = await app.db
			.select({
				collectionId: content.collectionId,
				slug: content.slug,
				locale: content.locale,
				status: content.status,
			})
			.from(content)
			.where(and(eq(content.id, id), eq(content.projectId, projectId)))
			.limit(1)
			.catch(() => [])
		if (!row) return
		collectionId = row.collectionId
		after = { id, slug: row.slug, locale: row.locale, status: row.status }
	} else if (!deleted) {
		after = {
			id,
			slug: typeof data.slug === 'string' ? data.slug : null,
			locale: typeof data.locale === 'string' ? data.locale : '',
			status: data.status as string,
		}
	}
	if (!collectionId) return

	const before: UrlState | null =
		typeof data.previousStatus === 'string'
			? {
					id,
					slug:
						data.previousSlug !== undefined
							? ((data.previousSlug as string | null) ?? null)
							: (after?.slug ?? (typeof data.slug === 'string' ? data.slug : null)),
					locale:
						typeof data.previousLocale === 'string'
							? data.previousLocale
							: (after?.locale ?? (typeof data.locale === 'string' ? data.locale : '')),
					status: data.previousStatus,
				}
			: null

	const [collection] = await app.db
		.select({ settings: collections.settings, fields: collections.fields })
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	const template = collection?.settings?.publicUrlTemplate
	if (!collection || !template) return

	const urls = affectedUrls(
		template,
		{ before, after },
		{
			localized: collection.fields.some((f) => f.localized),
			projectLocales: projectLocales(project.settings),
		},
	)
	await enqueueUrls(app, {
		projectId,
		collectionId,
		urls,
		reason: 'change',
		dueAt: new Date(Date.now() + indexNowDebounceMs()),
	})
}

/** Queue URLs once each; a URL already queued for the project stays as it is. */
async function enqueueUrls(
	app: FastifyInstance,
	input: {
		projectId: string
		collectionId: string
		urls: string[]
		reason: 'change' | 'resubmit'
		dueAt: Date
	},
): Promise<void> {
	const rows = input.urls.flatMap((url) => {
		const host = url.length <= MAX_URL_LENGTH ? hostOf(url) : null
		if (!host) {
			app.log.warn({ url: url.slice(0, 200) }, '[indexnow] skipped an unusable URL')
			return []
		}
		return [
			{
				projectId: input.projectId,
				collectionId: input.collectionId,
				host,
				url,
				reason: input.reason,
				nextAttemptAt: input.dueAt,
			},
		]
	})
	// Bounded statements: a resubmit of a large collection inserts in slices.
	for (let i = 0; i < rows.length; i += 1000) {
		await app.db
			.insert(indexNowQueue)
			.values(rows.slice(i, i + 1000))
			.onConflictDoNothing({ target: [indexNowQueue.projectId, indexNowQueue.url] })
	}
}

/**
 * Send every group (project, collection, host) that has a due URL. A due group
 * also takes its fresh URLs whose debounce has not run out yet, so a burst of
 * edits leaves as one request. `now` is injectable for tests.
 */
export async function flushIndexNowQueue(
	app: FastifyInstance,
	opts: { now?: Date; maxUrlsPerRequest?: number } = {},
): Promise<{ requests: number; submitted: number }> {
	const now = opts.now ?? new Date()
	const max = Math.min(
		opts.maxUrlsPerRequest ?? INDEXNOW_MAX_URLS_PER_REQUEST,
		INDEXNOW_MAX_URLS_PER_REQUEST,
	)
	const at = sql`${now.toISOString()}::timestamptz`
	const groups = await app.db
		.selectDistinct({
			projectId: indexNowQueue.projectId,
			collectionId: indexNowQueue.collectionId,
			host: indexNowQueue.host,
		})
		.from(indexNowQueue)
		.where(
			and(
				sql`${indexNowQueue.nextAttemptAt} <= ${at}`,
				sql`(${indexNowQueue.leaseUntil} IS NULL OR ${indexNowQueue.leaseUntil} <= ${at})`,
			),
		)
		.limit(MAX_GROUPS_PER_FLUSH)

	let requests = 0
	let submitted = 0
	for (const group of groups) {
		for (let round = 0; round < MAX_ROUNDS_PER_GROUP; round++) {
			const result = await flushGroup(app, group, now, max)
			requests += result.requests
			submitted += result.submitted
			if (!result.more) break
		}
	}
	return { requests, submitted }
}

interface Group {
	projectId: string
	collectionId: string | null
	host: string
}

async function flushGroup(
	app: FastifyInstance,
	group: Group,
	now: Date,
	max: number,
): Promise<{ requests: number; submitted: number; more: boolean }> {
	const token = randomUUID()
	const at = sql`${now.toISOString()}::timestamptz`
	const sameGroup = and(
		eq(indexNowQueue.projectId, group.projectId),
		group.collectionId
			? eq(indexNowQueue.collectionId, group.collectionId)
			: sql`${indexNowQueue.collectionId} IS NULL`,
		eq(indexNowQueue.host, group.host),
	)
	// Claim: SKIP LOCKED plus the lease keep a sibling instance on other rows.
	const rows = await app.db
		.update(indexNowQueue)
		.set({ leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) })
		.where(
			inArray(
				indexNowQueue.id,
				sql`(SELECT ${indexNowQueue.id} FROM ${indexNowQueue} WHERE ${sameGroup}
					AND (${indexNowQueue.leaseUntil} IS NULL OR ${indexNowQueue.leaseUntil} <= ${at})
					AND (${indexNowQueue.attempts} = 0 OR ${indexNowQueue.nextAttemptAt} <= ${at})
					ORDER BY ${indexNowQueue.createdAt} LIMIT ${max} FOR UPDATE SKIP LOCKED)`,
			),
		)
		.returning()
	if (rows.length === 0) return { requests: 0, submitted: 0, more: false }
	rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
	const more = rows.length === max
	const claimed = eq(indexNowQueue.leaseToken, token)
	const urls = rows.map((r) => r.url)
	const trigger = rows.some((r) => r.reason === 'change') ? 'change' : 'resubmit'
	const log = (
		status: 'success' | 'retrying' | 'waiting' | 'failed',
		statusCode: number | null,
		message: string,
		count = urls.length,
	) =>
		app.db.insert(indexNowSubmissions).values({
			projectId: group.projectId,
			collectionId: group.collectionId,
			host: group.host,
			urlCount: count,
			sampleUrls: urls.slice(0, 5),
			status,
			statusCode,
			message: message.slice(0, 1000),
			trigger,
		})

	const [project] = await app.db
		.select({ settings: projects.settings })
		.from(projects)
		.where(eq(projects.id, group.projectId))
		.limit(1)
	const settings = readIndexNowSettings(project?.settings)
	// Switched off after these were queued: drop them quietly.
	if (!settings?.enabled) {
		await app.db.delete(indexNowQueue).where(claimed)
		return { requests: 0, submitted: 0, more }
	}

	// The site's host goes through the same outbound guard as webhooks and
	// covers: IndexNow (and the key-file check below) must never be pointed at
	// an internal address.
	const blocked = await validatePublicUrl(`https://${group.host}/`)
	if (blocked) {
		await app.db.delete(indexNowQueue).where(claimed)
		await log('failed', null, `The host ${group.host} is not allowed: ${blocked}`)
		return { requests: 0, submitted: 0, more: false }
	}

	const keyLocation = keyLocationFor(settings, group.host)
	const keyCheck = await verifyKeyFile(keyLocation, settings.key)
	if (!keyCheck.ok) {
		const expired = rows.filter((r) => now.getTime() - r.createdAt.getTime() > MAX_QUEUE_AGE_MS)
		if (expired.length > 0) {
			await app.db.delete(indexNowQueue).where(
				and(
					claimed,
					inArray(
						indexNowQueue.id,
						expired.map((r) => r.id),
					),
				),
			)
			await log(
				'failed',
				keyCheck.statusCode,
				`Gave up after 7 days without a valid key file. ${keyCheck.message}`,
				expired.length,
			)
		}
		// Log the hold once, when it starts, not on every recheck.
		const startsWaiting = rows.some((r) => r.lastError === null && !expired.includes(r))
		await app.db
			.update(indexNowQueue)
			.set({
				nextAttemptAt: new Date(now.getTime() + KEY_RECHECK_MS),
				leaseToken: null,
				leaseUntil: null,
				lastError: keyCheck.message,
			})
			.where(claimed)
		if (startsWaiting && expired.length < rows.length) {
			await log(
				'waiting',
				keyCheck.statusCode,
				`Held until the site serves the key file. ${keyCheck.message}`,
				rows.length - expired.length,
			)
		}
		return { requests: 0, submitted: 0, more: false }
	}

	const result = await submitToIndexNow({
		host: group.host,
		key: settings.key,
		keyLocation,
		urls,
	})

	if (result.outcome === 'success') {
		await app.db.delete(indexNowQueue).where(claimed)
		await log('success', result.statusCode, result.message)
		return { requests: 1, submitted: urls.length, more }
	}

	if (result.outcome === 'fail') {
		await app.db.delete(indexNowQueue).where(claimed)
		await log('failed', result.statusCode, result.message)
		return { requests: 1, submitted: 0, more: false }
	}

	// Transient: back off per attempt count; a batch can mix fresh and retried rows.
	let givenUp = 0
	for (const attempts of new Set(rows.map((r) => r.attempts))) {
		const next = attempts + 1
		const ofAttempt = and(claimed, eq(indexNowQueue.attempts, attempts))
		if (next >= INDEXNOW_MAX_ATTEMPTS) {
			givenUp += rows.filter((r) => r.attempts === attempts).length
			await app.db.delete(indexNowQueue).where(ofAttempt)
			continue
		}
		await app.db
			.update(indexNowQueue)
			.set({
				attempts: next,
				nextAttemptAt: new Date(now.getTime() + retryDelayMs(next, result.retryAfter, now)),
				leaseToken: null,
				leaseUntil: null,
				lastError: result.message.slice(0, 1000),
			})
			.where(ofAttempt)
	}
	if (givenUp === rows.length) {
		await log(
			'failed',
			result.statusCode,
			`Gave up after ${INDEXNOW_MAX_ATTEMPTS} attempts: ${result.message}`,
		)
	} else {
		await log('retrying', result.statusCode, result.message)
	}
	return { requests: 1, submitted: 0, more: false }
}

export type CollectionUrlsResult =
	| { ok: true; queued: number; skipped: number }
	| { ok: false; status: number; error: string }

/**
 * Queue every published record of a collection, due at once (`resubmit`) or as
 * removals after the debounce (the collection is about to be deleted).
 */
export async function queueCollectionUrls(
	app: FastifyInstance,
	projectId: string,
	collectionId: string,
	mode: 'resubmit' | 'remove',
): Promise<CollectionUrlsResult> {
	const [project] = await app.db
		.select({ settings: projects.settings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
	const [collection] = await app.db
		.select({ settings: collections.settings, fields: collections.fields })
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	if (!project || !collection) return { ok: false, status: 404, error: 'Collection not found' }
	if (!readIndexNowSettings(project.settings)?.enabled) {
		return {
			ok: false,
			status: 400,
			error:
				'IndexNow is not enabled for this project. Enable it in Settings → Developer → IndexNow first.',
		}
	}
	const template = collection.settings?.publicUrlTemplate
	if (!template) {
		return {
			ok: false,
			status: 400,
			error:
				'This collection has no public URL template, so its records have no URLs to submit. Set one in the collection settings first.',
		}
	}
	const opts = {
		localized: collection.fields.some((f) => f.localized),
		projectLocales: projectLocales(project.settings),
	}
	const dueAt = mode === 'resubmit' ? new Date() : new Date(Date.now() + indexNowDebounceMs())
	let queued = 0
	let skipped = 0
	let cursor: string | null = null
	for (;;) {
		const page: Array<{ id: string; slug: string | null; locale: string }> = await app.db
			.select({ id: content.id, slug: content.slug, locale: content.locale })
			.from(content)
			.where(
				and(
					eq(content.projectId, projectId),
					eq(content.collectionId, collectionId),
					eq(content.status, 'published'),
					...(cursor ? [gt(content.id, cursor)] : []),
				),
			)
			.orderBy(asc(content.id))
			.limit(1000)
		if (page.length === 0) break
		cursor = page[page.length - 1].id
		const urls: string[] = []
		for (const record of page) {
			const recordUrlList = recordUrls(template, record, opts)
			if (recordUrlList.length === 0) skipped++
			urls.push(...recordUrlList)
		}
		const unique = [...new Set(urls)]
		queued += unique.length
		await enqueueUrls(app, {
			projectId,
			collectionId,
			urls: unique,
			reason: mode === 'resubmit' ? 'resubmit' : 'change',
			dueAt,
		})
		if (page.length < 1000) break
	}
	return { ok: true, queued, skipped }
}

/** Hosts a project submits for: its collections' URL templates plus the key location's. */
export async function indexNowHosts(
	app: FastifyInstance,
	projectId: string,
	settings: IndexNowSettings | null,
): Promise<string[]> {
	const rows = await app.db
		.select({ settings: collections.settings })
		.from(collections)
		.where(
			and(
				eq(collections.projectId, projectId),
				isNotNull(sql`${collections.settings}->>'publicUrlTemplate'`),
			),
		)
	const hosts = new Set<string>()
	if (settings?.keyLocation) {
		const host = hostOf(settings.keyLocation)
		if (host) hosts.add(host)
	}
	for (const row of rows) {
		const check = row.settings?.publicUrlTemplate
			? checkUrlTemplate(row.settings.publicUrlTemplate)
			: null
		if (check?.ok) hosts.add(check.host)
	}
	return [...hosts].sort()
}

/** Settings, per-collection state and recent submissions, for the admin and MCP. */
export async function getIndexNowStatus(app: FastifyInstance, projectId: string) {
	const [project] = await app.db
		.select({ settings: projects.settings })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1)
	const settings = readIndexNowSettings(project?.settings)
	const hosts = await indexNowHosts(app, projectId, settings)

	const withTemplate = await app.db
		.select({
			id: collections.id,
			name: collections.name,
			label: collections.label,
			settings: collections.settings,
		})
		.from(collections)
		.where(
			and(
				eq(collections.projectId, projectId),
				isNotNull(sql`${collections.settings}->>'publicUrlTemplate'`),
			),
		)
		.orderBy(asc(collections.label))

	const counts = await app.db
		.select({
			collectionId: indexNowQueue.collectionId,
			pending: sql<number>`cast(count(*) as int)`,
			waiting: sql<number>`cast(count(*) filter (where ${indexNowQueue.lastError} is not null and ${indexNowQueue.attempts} = 0) as int)`,
		})
		.from(indexNowQueue)
		.where(eq(indexNowQueue.projectId, projectId))
		.groupBy(indexNowQueue.collectionId)
	const countBy = new Map(counts.map((c) => [c.collectionId, c]))

	const submissionColumns = {
		id: indexNowSubmissions.id,
		collectionId: indexNowSubmissions.collectionId,
		host: indexNowSubmissions.host,
		urlCount: indexNowSubmissions.urlCount,
		sampleUrls: indexNowSubmissions.sampleUrls,
		status: indexNowSubmissions.status,
		statusCode: indexNowSubmissions.statusCode,
		message: indexNowSubmissions.message,
		trigger: indexNowSubmissions.trigger,
		createdAt: indexNowSubmissions.createdAt,
	}
	const latest = await app.db
		.selectDistinctOn([indexNowSubmissions.collectionId], submissionColumns)
		.from(indexNowSubmissions)
		.where(eq(indexNowSubmissions.projectId, projectId))
		.orderBy(indexNowSubmissions.collectionId, desc(indexNowSubmissions.createdAt))
	const latestBy = new Map(latest.map((s) => [s.collectionId, s]))

	const recent = await app.db
		.select(submissionColumns)
		.from(indexNowSubmissions)
		.where(eq(indexNowSubmissions.projectId, projectId))
		.orderBy(desc(indexNowSubmissions.createdAt))
		.limit(20)

	return {
		settings: {
			enabled: settings?.enabled ?? false,
			key: settings?.key ?? null,
			keyLocation: settings?.keyLocation ?? null,
		},
		keyFiles: settings
			? hosts.map((host) => {
					const url = keyLocationFor(settings, host)
					return { host, url, path: new URL(url).pathname }
				})
			: [],
		collections: withTemplate.map((c) => {
			const last = latestBy.get(c.id)
			return {
				id: c.id,
				name: c.name,
				label: c.label,
				publicUrlTemplate: c.settings.publicUrlTemplate ?? null,
				pending: countBy.get(c.id)?.pending ?? 0,
				waiting: countBy.get(c.id)?.waiting ?? 0,
				lastSubmission: last
					? {
							status: last.status,
							statusCode: last.statusCode,
							message: last.message,
							urlCount: last.urlCount,
							trigger: last.trigger,
							createdAt: last.createdAt,
						}
					: null,
			}
		}),
		recent,
	}
}
