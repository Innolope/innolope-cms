import { content } from '@innolope/db'
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { syncExternalStatus } from './external-content.js'

/**
 * How often to look for content whose publish time has arrived. A minute is the
 * granularity the editor's datetime picker offers, so polling faster only adds
 * queries — the publish itself is a single indexed lookup.
 */
const POLL_INTERVAL_MS = 60_000

/** Cap per tick so one enormous backlog can't hold the event loop. */
const BATCH_SIZE = 50

/**
 * Publishes content whose scheduled moment has passed.
 *
 * Deliberately NOT license-gated: setting a schedule requires the entitlement
 * (see `checkSchedulable`), but once something is scheduled it must go live even
 * if the license later lapses. Stranding a customer's queued content behind an
 * expired subscription is a worse failure than serving one more post.
 */
export function initScheduledPublisher(app: FastifyInstance) {
	if (!app.db) return

	let running = false
	const interval = setInterval(async () => {
		if (running) return
		running = true
		try {
			await publishDueContent(app)
		} catch (err) {
			app.log.error(err, 'Scheduled publisher error')
		} finally {
			running = false
		}
	}, POLL_INTERVAL_MS)

	app.addHook('onClose', () => clearInterval(interval))
}

/**
 * One pass: flip every due `scheduled` row to `published`.
 *
 * Order matters. The external write happens first because it is idempotent — a
 * crash between the two steps leaves the source row correct and the CMS row
 * still `scheduled`, so the next tick simply retries. Doing it the other way
 * round would mark the record published locally while the site never sees it.
 *
 * The local flip is guarded by `status = 'scheduled'`, so with several API
 * instances polling the same database exactly one of them wins the row and emits
 * the event.
 *
 * `publishedAt` is left untouched: the scheduled moment *is* the publication
 * date, and rewriting it to the worker's wake-up time would drift every post a
 * few seconds past the time the author chose.
 *
 * Returns the number of records published.
 */
export async function publishDueContent(app: FastifyInstance): Promise<number> {
	const due = await app.db
		.select()
		.from(content)
		.where(
			and(
				eq(content.status, 'scheduled'),
				isNotNull(content.publishedAt),
				lte(content.publishedAt, new Date()),
			),
		)
		.orderBy(asc(content.publishedAt))
		.limit(BATCH_SIZE)

	let published = 0
	for (const item of due) {
		try {
			const outcome = await syncExternalStatus(
				app,
				item.projectId,
				item.collectionId,
				item.externalId,
				'published',
				item.publishedAt,
			)
			// A collection whose source table cannot record a status will never be able
			// to. Retrying would pin the row in the queue forever, so publish it locally
			// and log — the record was already visible to the site the whole time.
			if (!outcome.synced && outcome.reason === 'unsupported') {
				app.log.warn(
					{ contentId: item.id, collectionId: item.collectionId },
					'Scheduled publish: source table cannot record status; published locally only',
				)
			}
		} catch (err) {
			// Leave the row scheduled and try again next tick — an external database
			// that is briefly unreachable must not silently publish only locally.
			app.log.warn({ err, contentId: item.id }, 'Scheduled publish: external sync failed')
			continue
		}

		const [updated] = await app.db
			.update(content)
			// No request behind this one: the publisher, not a client, performed the
			// last write. Leaving the previous source in place would credit whoever
			// scheduled the post with a publish they were not present for.
			.set({ status: 'published', updatedAt: new Date(), updatedBy: null, updatedSource: 'system' })
			.where(and(eq(content.id, item.id), eq(content.status, 'scheduled')))
			.returning()
		if (!updated) continue // another instance got there first

		published++
		app.events.emit({
			type: 'content:published',
			data: {
				id: updated.id,
				slug: updated.slug,
				projectId: updated.projectId,
				scheduled: true,
			},
			timestamp: new Date().toISOString(),
		})
	}

	if (published > 0) app.log.info({ published }, 'Scheduled publisher: published due content')
	return published
}
