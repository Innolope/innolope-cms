import type { FastifyInstance } from 'fastify'
import type { CmsEvent } from '../plugins/events.js'

interface EventRecord {
	id: string
	slug: string | null
	status: string
	collectionId?: string
	locale?: string
}

interface PreviousState {
	status: string | null
	slug?: string | null
	locale?: string
}

/**
 * The shared `data` of a content event: the record after the write and, when
 * the emitter knows it, before it. `previousSlug` / `previousLocale` appear only
 * when the write changed them. Subscribers that act on the public site (IndexNow)
 * need the before state to find a page that was unpublished or moved; webhooks
 * pass it through.
 */
export function contentEventData(record: EventRecord, previous?: PreviousState | null) {
	return {
		id: record.id,
		slug: record.slug,
		status: record.status,
		...(record.collectionId !== undefined && { collectionId: record.collectionId }),
		...(record.locale !== undefined && { locale: record.locale }),
		...(previous !== undefined && {
			previousStatus: previous?.status ?? null,
			...(previous?.slug !== undefined &&
				previous.slug !== record.slug && { previousSlug: previous.slug }),
			...(previous?.locale !== undefined &&
				previous.locale !== record.locale && { previousLocale: previous.locale }),
		}),
	}
}

/**
 * `data` of `content:deleted`. There is no state after the write, so `status`
 * is absent and `previousStatus` is what the record was when it was deleted.
 */
export function deletedContentEventData(record: Omit<EventRecord, 'status'> & { status?: string }) {
	return {
		id: record.id,
		slug: record.slug,
		...(record.collectionId !== undefined && { collectionId: record.collectionId }),
		...(record.locale !== undefined && { locale: record.locale }),
		previousStatus: record.status ?? null,
	}
}

/**
 * Emit the route's own lifecycle event and, when the write crossed into
 * `published`, also emit `content:published` so publish subscribers (webhooks,
 * SSE, analytics) see every publish regardless of which route performed it.
 *
 * Routes whose contract is already "updated OR published, exclusively" (the
 * single-item PUT, /publish, bulk-action, the scheduled publisher) don't use
 * this helper — for them a second event would change existing semantics. Here
 * the double emit is deliberate: an "all events" subscriber gets both the base
 * event and content:published for one transition.
 */
export function emitContentStatusEvent(
	app: FastifyInstance,
	options: {
		base: Exclude<CmsEvent['type'], 'content:published'>
		/** Status before the write; null/undefined for newly created content. */
		previousStatus: string | null | undefined
		/** Slug and locale before the write, when it may have changed them. */
		previous?: { slug: string | null; locale: string }
		updated: EventRecord
		projectId: string
		extraData?: Record<string, unknown>
	},
) {
	const { base, previousStatus, previous, updated, projectId, extraData } = options
	const data = {
		...contentEventData(updated, { status: previousStatus ?? null, ...previous }),
		projectId,
		...extraData,
	}
	const timestamp = new Date().toISOString()

	app.events.emit({ type: base, data, timestamp })

	if (updated.status === 'published' && previousStatus !== 'published') {
		app.events.emit({ type: 'content:published', data, timestamp })
	}
}
