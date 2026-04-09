import type { FastifyInstance, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

export interface CmsEvent {
	type: 'content:created' | 'content:updated' | 'content:published' | 'content:deleted' | 'media:uploaded' | 'media:deleted'
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
				} catch {
					// Ignore listener errors
				}
			}
		},
		subscribe(listener: EventListener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	})
})
