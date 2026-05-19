import { projects } from '@innolope/db'
import { and, eq, ne } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getProject } from '../../plugins/project.js'
import {
	generateVerificationToken,
	normalizeDomain,
	verificationRecord,
	verifyTxtRecord,
} from '../../services/domain-verification.js'

/** Reject if the URL `:id` doesn't match the project authorized by `requireProject`. */
async function assertProjectParam(request: FastifyRequest, reply: FastifyReply) {
	const paramId = (request.params as { id?: string }).id
	if (paramId && paramId !== getProject(request).id) {
		return reply.status(404).send({ error: 'Project not found' })
	}
}

/** The CNAME/A target operators expose for customers to point their domain at. */
function domainTarget(): string {
	if (process.env.CUSTOM_DOMAIN_TARGET) return process.env.CUSTOM_DOMAIN_TARGET
	try {
		return new URL(process.env.ADMIN_URL ?? 'http://localhost').hostname
	} catch {
		return 'localhost'
	}
}

function domainStatus(project: typeof projects.$inferSelect) {
	const domain = project.customDomain
	if (!domain) {
		return { domain: null, verified: false, verifiedAt: null, dnsRecord: null, target: domainTarget() }
	}
	const verified = project.customDomainVerifiedAt != null
	return {
		domain,
		verified,
		verifiedAt: project.customDomainVerifiedAt,
		dnsRecord: project.customDomainToken
			? verificationRecord(domain, project.customDomainToken)
			: null,
		target: domainTarget(),
	}
}

export async function customDomainRoutes(app: FastifyInstance) {
	const guards = [
		app.requireProject('admin'),
		assertProjectParam,
		app.requireLicense('custom-domain'),
	]

	// Current custom-domain status for the project.
	app.get<{ Params: { id: string } }>(
		'/:id/custom-domain',
		{ preHandler: guards },
		async (request) => {
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			return domainStatus(project)
		},
	)

	// Set or change the custom domain. Resets verification state.
	app.put<{ Params: { id: string } }>(
		'/:id/custom-domain',
		{ preHandler: guards },
		async (request, reply) => {
			const { domain } = request.body as { domain?: string }
			const normalized = normalizeDomain(domain ?? '')
			if (!normalized) {
				return reply.status(400).send({ error: 'Enter a valid domain, e.g. cms.example.com' })
			}

			// Reject if another project already uses this domain.
			const [conflict] = await app.db
				.select({ id: projects.id })
				.from(projects)
				.where(and(eq(projects.customDomain, normalized), ne(projects.id, getProject(request).id)))
				.limit(1)
			if (conflict) {
				return reply.status(409).send({ error: 'This domain is already linked to another project.' })
			}

			const [updated] = await app.db
				.update(projects)
				.set({
					customDomain: normalized,
					customDomainToken: generateVerificationToken(),
					customDomainVerifiedAt: null,
					updatedAt: new Date(),
				})
				.where(eq(projects.id, getProject(request).id))
				.returning()

			return domainStatus(updated)
		},
	)

	// Check the DNS TXT record and mark the domain verified on success.
	app.post<{ Params: { id: string } }>(
		'/:id/custom-domain/verify',
		{ preHandler: guards },
		async (request, reply) => {
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)

			if (!project.customDomain || !project.customDomainToken) {
				return reply.status(400).send({ error: 'No custom domain configured.' })
			}

			const ok = await verifyTxtRecord(project.customDomain, project.customDomainToken)
			if (!ok) {
				return reply.status(400).send({
					error:
						'Verification TXT record not found yet. DNS changes can take a few minutes to propagate.',
				})
			}

			const [updated] = await app.db
				.update(projects)
				.set({ customDomainVerifiedAt: new Date(), updatedAt: new Date() })
				.where(eq(projects.id, getProject(request).id))
				.returning()

			return domainStatus(updated)
		},
	)

	// Remove the custom domain.
	app.delete<{ Params: { id: string } }>(
		'/:id/custom-domain',
		{ preHandler: guards },
		async (request, reply) => {
			await app.db
				.update(projects)
				.set({
					customDomain: null,
					customDomainToken: null,
					customDomainVerifiedAt: null,
					updatedAt: new Date(),
				})
				.where(eq(projects.id, getProject(request).id))
			return reply.status(204).send()
		},
	)
}
