import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

export interface CmsEvent {
	type:
		| 'content:created'
		| 'content:updated'
		| 'content:published'
		| 'content:deleted'
		| 'content:submitted'
		| 'content:approved'
		| 'content:rejected'
		| 'media:uploaded'
		| 'media:deleted'
		| 'auth:login'
		| 'auth:logout'
		| 'auth:registered'
		| 'auth:password_changed'
		| 'auth:sso_initiated'
		| 'auth:sso_login'
		| 'auth:sso_failed'
		| 'auth:sso_linked'
		| 'auth:sso_unlinked'
		| 'sso:connection_created'
		| 'sso:connection_updated'
		| 'sso:connection_deleted'
		| 'scim:user_created'
		| 'scim:user_updated'
		| 'scim:user_deactivated'
	data: Record<string, unknown>
	timestamp: string
}

type EventListener = (event: CmsEvent) => void | Promise<void>

declare module 'fastify' {
	interface FastifyInstance {
		events: {
			emit: (event: CmsEvent) => void
			subscribe: (listener: EventListener) => () => void
		}
	}
}

export const eventsPlugin = fp(async (app: FastifyInstance) => {
	const listeners = new Set<EventListener>()

	app.decorate('events', {
		emit(event: CmsEvent) {
			for (const listener of listeners) {
				try {
					// Listeners run fire-and-forget. Capture both synchronous throws and
					// async rejections so a rejected promise can't become an unhandled
					// rejection (which crashes the process on Node 22+).
					const result = listener(event)
					if (result && typeof (result as Promise<void>).catch === 'function') {
						;(result as Promise<void>).catch((err) => {
							app.log.error(err, '[events] async listener rejected')
						})
					}
				} catch (err) {
					// Listeners must never break event emitters, but we should still see them
					app.log.error(err, '[events] listener threw')
				}
			}
		},
		subscribe(listener: EventListener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	})
})
