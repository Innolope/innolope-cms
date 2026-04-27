import type { FastifyInstance, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

export interface CmsEvent {
	type: 'content:created' | 'content:updated' | 'content:published' | 'content:deleted' | 'content:submitted' | 'content:approved' | 'content:rejected' | 'media:uploaded' | 'media:deleted' | 'auth:login' | 'auth:logout' | 'auth:registered' | 'auth:password_changed' | 'auth:sso_initiated' | 'auth:sso_login' | 'auth:sso_failed' | 'auth:sso_linked' | 'auth:sso_unlinked' | 'sso:connection_created' | 'sso:connection_updated' | 'sso:connection_deleted' | 'scim:user_created' | 'scim:user_updated' | 'scim:user_deactivated'
	data: Record<string, unknown>
	timestamp: string
}

type EventListener = (event: CmsEvent) => void

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
					listener(event)
				} catch (err) {
					// Listeners must never break event emitters, but we should still see them
					console.error('[events] listener threw:', err)
				}
			}
		},
		subscribe(listener: EventListener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	})
})
