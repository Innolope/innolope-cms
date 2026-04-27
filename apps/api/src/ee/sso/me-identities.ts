import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { ssoConnections, userIdentities } from '@innolope/db'

/** /api/v1/auth/me/identities — list/unlink SSO identities for the current user. */
export async function meIdentitiesRoutes(app: FastifyInstance) {
	app.get(
		'/',
		{ preHandler: [app.authenticate, app.requireLicense('sso')] },
		async (request) => {
			const rows = await app.db
				.select({
					id: userIdentities.id,
					connectionId: userIdentities.connectionId,
					provider: userIdentities.provider,
					email: userIdentities.email,
					lastLoginAt: userIdentities.lastLoginAt,
					createdAt: userIdentities.createdAt,
					connectionName: ssoConnections.name,
					connectionSlug: ssoConnections.slug,
					projectId: ssoConnections.projectId,
				})
				.from(userIdentities)
				.leftJoin(ssoConnections, eq(userIdentities.connectionId, ssoConnections.id))
				.where(eq(userIdentities.userId, request.user!.id))
			return rows
		},
	)

	// Unlink
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.authenticate, app.requireLicense('sso')] },
		async (request, reply) => {
			const [identity] = await app.db
				.select({ connectionId: userIdentities.connectionId, userId: userIdentities.userId })
				.from(userIdentities)
				.where(eq(userIdentities.id, request.params.id))
				.limit(1)
			if (!identity || identity.userId !== request.user!.id) {
				return reply.status(404).send({ error: 'Not found' })
			}

			// If this connection enforces SSO and the user has no password, block unlink
			const [connection] = await app.db
				.select({ enforceSso: ssoConnections.enforceSso })
				.from(ssoConnections)
				.where(eq(ssoConnections.id, identity.connectionId))
				.limit(1)

			if (connection?.enforceSso) {
				// Check for any other way to log in: another identity, or a password
				const { users } = await import('@innolope/db')
				const [user] = await app.db
					.select({ passwordHash: users.passwordHash })
					.from(users)
					.where(eq(users.id, request.user!.id))
					.limit(1)
				const otherIdentities = await app.db
					.select({ id: userIdentities.id })
					.from(userIdentities)
					.where(and(eq(userIdentities.userId, request.user!.id)))
				const hasOtherWay = Boolean(user?.passwordHash) || otherIdentities.length > 1
				if (!hasOtherWay) {
					return reply.status(400).send({ error: 'Cannot unlink the only login method under an enforced SSO connection.' })
				}
			}

			await app.db.delete(userIdentities).where(eq(userIdentities.id, request.params.id))

			app.events.emit({
				type: 'auth:sso_unlinked',
				data: { userId: request.user!.id, connectionId: identity.connectionId },
				timestamp: new Date().toISOString(),
			})
			return reply.status(204).send()
		},
	)
}
