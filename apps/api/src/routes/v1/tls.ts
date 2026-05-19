import { projects } from '@innolope/db'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { normalizeDomain } from '../../services/domain-verification.js'

/** Hostname of the operator's primary domain (from ADMIN_URL). */
function primaryHost(): string | null {
	try {
		return new URL(process.env.ADMIN_URL ?? '').hostname || null
	} catch {
		return null
	}
}

/**
 * On-demand TLS authorization endpoint for Caddy.
 * Caddy calls `GET /api/v1/tls/check?domain=<host>` before issuing a certificate;
 * a 2xx response authorizes issuance. We allow the primary domain and any project's
 * verified custom domain — nothing else — so unverified hosts can't trigger ACME.
 */
export async function tlsRoutes(app: FastifyInstance) {
	app.get<{ Querystring: { domain?: string } }>('/check', async (request, reply) => {
		const domain = normalizeDomain(request.query.domain ?? '')
		if (!domain) return reply.status(400).send({ error: 'Missing domain' })

		if (domain === primaryHost()) return reply.status(200).send({ ok: true })

		const [match] = await app.db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.customDomain, domain), isNotNull(projects.customDomainVerifiedAt)))
			.limit(1)

		if (match) return reply.status(200).send({ ok: true })
		return reply.status(403).send({ error: 'Domain not authorized' })
	})
}
