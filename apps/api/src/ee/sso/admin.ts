import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { scimTokens, ssoConnections, userIdentities } from '@innolope/db'
import { encryptSecret, decryptSecret } from '../../lib/crypto.js'

type Protocol = 'saml' | 'oidc'

interface CreateBody {
	protocol: Protocol
	name: string
	slug: string
	enabled?: boolean
	enforceSso?: boolean
	allowIdpInitiated?: boolean
	domains?: string[]
	oidcIssuer?: string
	oidcClientId?: string
	oidcClientSecret?: string
	oidcScopes?: string[]
	samlEntityId?: string
	samlSsoUrl?: string
	samlIdpCertPems?: string[]
	samlWantAssertionsSigned?: boolean
	samlWantAssertionsEncrypted?: boolean
	attrEmail?: string
	attrName?: string
	attrGroups?: string
	defaultRole?: 'admin' | 'editor' | 'viewer'
	groupRoleMap?: Record<string, 'admin' | 'editor' | 'viewer'>
}

type UpdateBody = Partial<CreateBody>

function redact(row: typeof ssoConnections.$inferSelect) {
	const { oidcClientSecretEnc: _secret, ...rest } = row
	return { ...rest, hasClientSecret: Boolean(_secret) }
}

export async function ssoAdminRoutes(app: FastifyInstance) {
	const preHandler = [app.requireProject('admin'), app.requireLicense('sso')]

	// List
	app.get('/', { preHandler }, async (request) => {
		const rows = await app.db
			.select()
			.from(ssoConnections)
			.where(eq(ssoConnections.projectId, request.project!.id))
		return rows.map(redact)
	})

	// Create
	app.post<{ Body: CreateBody }>('/', { preHandler }, async (request, reply) => {
		const body = request.body
		if (!body.name || !body.slug || !body.protocol) {
			return reply.status(400).send({ error: 'name, slug, and protocol are required' })
		}
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.slug)) {
			return reply.status(400).send({ error: 'slug must be lowercase alphanumeric or dash' })
		}

		const encSecret = body.oidcClientSecret ? encryptSecret(body.oidcClientSecret) : null

		const [created] = await app.db
			.insert(ssoConnections)
			.values({
				projectId: request.project!.id,
				protocol: body.protocol,
				name: body.name,
				slug: body.slug,
				enabled: body.enabled ?? false,
				enforceSso: body.enforceSso ?? false,
				allowIdpInitiated: body.allowIdpInitiated ?? false,
				domains: body.domains ?? [],
				oidcIssuer: body.oidcIssuer,
				oidcClientId: body.oidcClientId,
				oidcClientSecretEnc: encSecret,
				oidcScopes: body.oidcScopes ?? ['openid', 'email', 'profile'],
				samlEntityId: body.samlEntityId,
				samlSsoUrl: body.samlSsoUrl,
				samlIdpCertPems: body.samlIdpCertPems ?? [],
				samlWantAssertionsSigned: body.samlWantAssertionsSigned ?? true,
				samlWantAssertionsEncrypted: body.samlWantAssertionsEncrypted ?? false,
				attrEmail: body.attrEmail ?? 'email',
				attrName: body.attrName ?? 'name',
				attrGroups: body.attrGroups ?? 'groups',
				defaultRole: body.defaultRole ?? 'viewer',
				groupRoleMap: body.groupRoleMap ?? {},
			})
			.returning()

		app.events.emit({
			type: 'sso:connection_created',
			data: { connectionId: created.id, projectId: created.projectId, protocol: created.protocol },
			timestamp: new Date().toISOString(),
		})

		return reply.status(201).send(redact(created))
	})

	// Get
	app.get<{ Params: { id: string } }>('/:id', { preHandler }, async (request, reply) => {
		const [row] = await app.db
			.select()
			.from(ssoConnections)
			.where(and(eq(ssoConnections.id, request.params.id), eq(ssoConnections.projectId, request.project!.id)))
			.limit(1)
		if (!row) return reply.status(404).send({ error: 'Not found' })
		return redact(row)
	})

	// Update
	app.put<{ Params: { id: string }; Body: UpdateBody }>('/:id', { preHandler }, async (request, reply) => {
		const body = request.body
		const updates: Record<string, unknown> = { updatedAt: new Date() }
		const passthrough: (keyof UpdateBody)[] = [
			'name', 'slug', 'enabled', 'enforceSso', 'allowIdpInitiated', 'domains',
			'oidcIssuer', 'oidcClientId', 'oidcScopes',
			'samlEntityId', 'samlSsoUrl', 'samlIdpCertPems', 'samlWantAssertionsSigned', 'samlWantAssertionsEncrypted',
			'attrEmail', 'attrName', 'attrGroups', 'defaultRole', 'groupRoleMap',
		]
		for (const k of passthrough) {
			if (body[k] !== undefined) updates[k] = body[k]
		}
		if (body.oidcClientSecret !== undefined) {
			updates.oidcClientSecretEnc = body.oidcClientSecret ? encryptSecret(body.oidcClientSecret) : null
		}

		const [updated] = await app.db
			.update(ssoConnections)
			.set(updates)
			.where(and(eq(ssoConnections.id, request.params.id), eq(ssoConnections.projectId, request.project!.id)))
			.returning()
		if (!updated) return reply.status(404).send({ error: 'Not found' })

		app.events.emit({
			type: 'sso:connection_updated',
			data: { connectionId: updated.id, projectId: updated.projectId },
			timestamp: new Date().toISOString(),
		})

		return redact(updated)
	})

	// Delete
	app.delete<{ Params: { id: string } }>('/:id', { preHandler }, async (request, reply) => {
		const [deleted] = await app.db
			.delete(ssoConnections)
			.where(and(eq(ssoConnections.id, request.params.id), eq(ssoConnections.projectId, request.project!.id)))
			.returning({ id: ssoConnections.id })
		if (!deleted) return reply.status(404).send({ error: 'Not found' })

		app.events.emit({
			type: 'sso:connection_deleted',
			data: { connectionId: deleted.id, projectId: request.project!.id },
			timestamp: new Date().toISOString(),
		})
		return reply.status(204).send()
	})
}
