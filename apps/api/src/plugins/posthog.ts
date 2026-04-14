import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type { CmsEvent } from './events.js'

interface PostHogCapture {
	distinctId: string
	event: string
	properties?: Record<string, unknown>
}

declare module 'fastify' {
	interface FastifyInstance {
		posthog: {
			capture: (params: PostHogCapture) => void
		} | null
	}
}

/** Map CMS event bus types to PostHog event names */
const EVENT_MAP: Record<CmsEvent['type'], string> = {
	'content:created': 'cms_content_created',
	'content:updated': 'cms_content_updated',
	'content:published': 'cms_content_published',
	'content:deleted': 'cms_content_deleted',
	'content:submitted': 'cms_content_submitted',
	'content:approved': 'cms_content_approved',
	'content:rejected': 'cms_content_rejected',
	'media:uploaded': 'cms_media_uploaded',
	'media:deleted': 'cms_media_deleted',
	'auth:login': 'cms_user_login',
	'auth:logout': 'cms_user_logout',
	'auth:registered': 'cms_user_registered',
	'auth:password_changed': 'cms_user_password_changed',
}

export const posthogPlugin = fp(async (app: FastifyInstance) => {
	const apiKey = process.env.POSTHOG_API_KEY
	const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com'
	const disabled = process.env.POSTHOG_DISABLED === 'true'

	if (!apiKey || disabled) {
		app.decorate('posthog', null)
		app.log.info('PostHog: disabled (no POSTHOG_API_KEY or POSTHOG_DISABLED=true)')
		return
	}

	// Dynamic import to avoid loading posthog-node when not configured
	const { PostHog } = await import('posthog-node')
	const posthog = new PostHog(apiKey, { host, flushAt: 20, flushInterval: 10000 })

	const capture = ({ distinctId, event, properties }: PostHogCapture) => {
		try {
			posthog.capture({ distinctId, event, properties })
		} catch (err) {
			app.log.warn({ err }, 'PostHog capture failed')
		}
	}

	// Subscribe to CMS event bus — forward all events to PostHog
	app.events.subscribe((event: CmsEvent) => {
		const phEvent = EVENT_MAP[event.type]
		if (!phEvent) return

		const data = event.data as Record<string, unknown>
		const distinctId = (data.userId as string) || (data.projectId as string) || 'system'

		capture({
			distinctId,
			event: phEvent,
			properties: {
				...data,
				cms_event_type: event.type,
				timestamp: event.timestamp,
			},
		})
	})

	app.decorate('posthog', { capture })
	app.log.info(`PostHog: enabled (host: ${host})`)

	// Flush on shutdown
	app.addHook('onClose', async () => {
		await posthog.shutdown()
		app.log.info('PostHog: flushed and shut down')
	})
})
