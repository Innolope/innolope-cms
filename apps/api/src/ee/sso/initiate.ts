import type { FastifyInstance } from 'fastify'
import { loadConnectionBySlug, initiateOidc } from './oidc.js'
import { initiateSaml } from './saml.js'
import { SsoError } from '../../services/sso-login.js'

/** Unified SP-initiated entrypoint that dispatches to OIDC or SAML based on the connection. */
export async function ssoInitiateRoutes(app: FastifyInstance) {
	const preLicense = [app.requireLicense('sso')]

	app.get<{ Params: { slug: string }; Querystring: { next?: string; intent?: string } }>(
		'/:slug/initiate',
		{ preHandler: preLicense, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
		async (request, reply) => {
			const connection = await loadConnectionBySlug(app, request.params.slug)
			if (!connection) return reply.status(404).send({ error: 'Not found' })

			let intent: 'login' | 'link' | 'test' = 'login'
			if (request.query.intent === 'link' || request.query.intent === 'test') {
				intent = request.query.intent
			}
			let linkUserId: string | undefined
			if (intent === 'link') {
				await app.authenticate(request, reply)
				if (reply.sent) return
				linkUserId = request.user!.id
			}

			try {
				const url =
					connection.protocol === 'oidc'
						? await initiateOidc(app, connection, { next: request.query.next, intent, linkUserId })
						: await initiateSaml(app, connection, { next: request.query.next, intent, linkUserId })

				app.events.emit({
					type: 'auth:sso_initiated',
					data: { connectionId: connection.id, protocol: connection.protocol, intent },
					timestamp: new Date().toISOString(),
				})
				return reply.redirect(url)
			} catch (err) {
				if (err instanceof SsoError) {
					return reply.status(err.statusCode).send({ error: err.message, code: err.code })
				}
				const e = err as Error
				app.log.error({ err: e }, 'SSO initiate failed')
				return reply.status(500).send({ error: e.message })
			}
		},
	)
}
