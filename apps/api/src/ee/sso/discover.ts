import type { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { ssoConnections } from '@innolope/db'

/**
 * Public email-domain discovery endpoint for SSO.
 * GET /api/v1/auth/sso/discover?email=user@acme.com
 * License-gated: returns 404 if SSO is not enabled for this install.
 */
export async function ssoDiscoverRoutes(app: FastifyInstance) {
	app.get(
		'/discover',
		{ config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
		async (request, reply) => {
			// License-gated without app.requireLicense to keep a clean 404 for unauthed clients
			if (!app.license.hasFeature('sso')) {
				return reply.status(404).send({ error: 'Not found' })
			}

			const { email } = request.query as { email?: string }
			if (!email) {
				return reply.status(400).send({ error: 'email query parameter required' })
			}
			const domain = email.split('@')[1]?.toLowerCase().trim()
			if (!domain) {
				return reply.status(400).send({ error: 'Invalid email' })
			}

			const [connection] = await app.db
				.select({
					id: ssoConnections.id,
					slug: ssoConnections.slug,
					projectId: ssoConnections.projectId,
					protocol: ssoConnections.protocol,
					enforceSso: ssoConnections.enforceSso,
					name: ssoConnections.name,
				})
				.from(ssoConnections)
				.where(
					and(
						eq(ssoConnections.enabled, true),
						sql`${domain} = ANY(${ssoConnections.domains})`,
					),
				)
				.limit(1)

			if (!connection) return reply.status(404).send({ error: 'No SSO connection for this email domain' })
			return connection
		},
	)
}
