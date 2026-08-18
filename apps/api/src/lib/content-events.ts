import type { FastifyInstance } from 'fastify'
import type { CmsEvent } from '../plugins/events.js'

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
		updated: { id: string; slug: string | null; status: string }
		projectId: string
		extraData?: Record<string, unknown>
	},
) {
	const { base, previousStatus, updated, projectId, extraData } = options
	const data = {
		id: updated.id,
		slug: updated.slug,
		status: updated.status,
		projectId,
		...extraData,
	}
	const timestamp = new Date().toISOString()

	app.events.emit({ type: base, data, timestamp })

	if (updated.status === 'published' && previousStatus !== 'published') {
		app.events.emit({ type: 'content:published', data, timestamp })
	}
}
