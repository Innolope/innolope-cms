import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { projectMembers, scimTokens, ssoConnections, userIdentities, users } from '@innolope/db'
import { createHash, randomUUID } from 'node:crypto'
import { revokeAllUserRefreshTokens } from '../../plugins/auth.js'

/**
 * SCIM 2.0 endpoints. Mounted at /api/v1/scim/v2/:connectionSlug.
 *
 * Auth: Bearer token matched against scim_tokens.tokenHash; token is tied to a connection.
 * License-gated via the 'sso' license feature.
 *
 * Supports Users resource: GET list (filter by userName), GET by id, POST create,
 * PATCH update (including active=false), PUT replace, DELETE.
 */
export async function scimRoutes(app: FastifyInstance) {
	async function authenticateScim(request: FastifyRequest, reply: FastifyReply) {
		if (!app.license.hasFeature('sso')) {
			return reply.status(404).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'Not found', status: '404' })
		}
		const auth = request.headers.authorization
		if (!auth?.startsWith('Bearer ')) {
			return reply.status(401).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'Missing bearer token', status: '401' })
		}
		const slug = (request.params as { slug: string }).slug
		const [connection] = await app.db
			.select()
			.from(ssoConnections)
			.where(eq(ssoConnections.slug, slug))
			.limit(1)
		if (!connection) {
			return reply.status(404).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'Unknown connection', status: '404' })
		}
		const rawToken = auth.slice(7)
		const tokenHash = createHash('sha256').update(rawToken).digest('hex')
		const [tokenRow] = await app.db
			.select()
			.from(scimTokens)
			.where(and(eq(scimTokens.connectionId, connection.id), eq(scimTokens.tokenHash, tokenHash), isNull(scimTokens.revokedAt)))
			.limit(1)
		if (!tokenRow) {
			return reply.status(401).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'Invalid token', status: '401' })
		}
		await app.db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, tokenRow.id))
		;(request as unknown as { scimConnection?: typeof connection }).scimConnection = connection
	}

	const preHandler = authenticateScim

	// Standard SCIM metadata endpoints
	app.get<{ Params: { slug: string } }>('/:slug/v2/ServiceProviderConfig', { preHandler }, async () => ({
		schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
		documentationUri: 'https://innolope.com/docs/sso-setup',
		patch: { supported: true },
		bulk: { supported: false },
		filter: { supported: true, maxResults: 200 },
		changePassword: { supported: false },
		sort: { supported: false },
		etag: { supported: false },
		authenticationSchemes: [
			{ name: 'Bearer', description: 'OAuth2 bearer token', specUri: 'https://datatracker.ietf.org/doc/html/rfc6750', type: 'oauthbearertoken', primary: true },
		],
	}))

	app.get<{ Params: { slug: string } }>('/:slug/v2/ResourceTypes', { preHandler }, async () => ({
		schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
		totalResults: 1,
		Resources: [
			{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User' },
		],
	}))

	// List / filter users
	app.get<{ Params: { slug: string }; Querystring: { filter?: string; count?: string; startIndex?: string } }>(
		'/:slug/v2/Users',
		{ preHandler },
		async (request) => {
			const connection = (request as unknown as { scimConnection: typeof ssoConnections.$inferSelect }).scimConnection
			// Only userName eq "<email>" is supported
			let emailFilter: string | undefined
			const f = request.query.filter
			if (f) {
				const m = f.match(/userName\s+eq\s+"([^"]+)"/i)
				if (m) emailFilter = m[1].toLowerCase()
			}

			// Users provisioned via this connection are those who have a user_identities row for it.
			const rows = await app.db
				.select({
					userId: users.id,
					email: users.email,
					name: users.name,
					role: users.role,
					identityId: userIdentities.id,
					memberRole: projectMembers.role,
					memberId: projectMembers.id,
				})
				.from(userIdentities)
				.innerJoin(users, eq(users.id, userIdentities.userId))
				.leftJoin(
					projectMembers,
					and(eq(projectMembers.userId, users.id), eq(projectMembers.projectId, connection.projectId)),
				)
				.where(eq(userIdentities.connectionId, connection.id))

			const filtered = emailFilter ? rows.filter((r) => r.email.toLowerCase() === emailFilter) : rows

			return {
				schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
				totalResults: filtered.length,
				startIndex: 1,
				itemsPerPage: filtered.length,
				Resources: filtered.map(toScimUser),
			}
		},
	)

	// Get by id
	app.get<{ Params: { slug: string; id: string } }>('/:slug/v2/Users/:id', { preHandler }, async (request, reply) => {
		const connection = (request as unknown as { scimConnection: typeof ssoConnections.$inferSelect }).scimConnection
		const row = await fetchProvisionedUser(app, connection, request.params.id)
		if (!row) return reply.status(404).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'User not found', status: '404' })
		return toScimUser(row)
	})

	// Create
	app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
		'/:slug/v2/Users',
		{ preHandler },
		async (request, reply) => {
			const connection = (request as unknown as { scimConnection: typeof ssoConnections.$inferSelect }).scimConnection
			const body = request.body || {}
			const userName = (body.userName as string | undefined)?.toLowerCase()
			const nameObj = (body.name as { formatted?: string; givenName?: string; familyName?: string } | undefined) ?? {}
			const displayName = (body.displayName as string | undefined) ?? nameObj.formatted ?? [nameObj.givenName, nameObj.familyName].filter(Boolean).join(' ')
			const externalId = (body.externalId as string | undefined) ?? userName
			const active = (body.active as boolean | undefined) ?? true

			if (!userName || !externalId) {
				return reply.status(400).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'userName and externalId required', status: '400' })
			}

			// Look up existing user by email
			const [existing] = await app.db.select().from(users).where(eq(users.email, userName)).limit(1)
			let userId: string
			if (existing) {
				userId = existing.id
			} else {
				const [created] = await app.db
					.insert(users)
					.values({ email: userName, name: displayName || userName.split('@')[0], passwordHash: null, role: 'editor' })
					.returning()
				userId = created.id
			}

			// Ensure an identity row exists tying the user to this connection.
			const [identity] = await app.db
				.select({ id: userIdentities.id })
				.from(userIdentities)
				.where(and(eq(userIdentities.connectionId, connection.id), eq(userIdentities.subject, externalId)))
				.limit(1)
			if (!identity) {
				await app.db.insert(userIdentities).values({
					userId,
					connectionId: connection.id,
					provider: connection.protocol,
					subject: externalId,
					email: userName,
					rawProfile: body as Record<string, unknown>,
				})
			}

			// Project membership (SCIM adds => ensure membership with connection's default role)
			const [member] = await app.db
				.select()
				.from(projectMembers)
				.where(and(eq(projectMembers.projectId, connection.projectId), eq(projectMembers.userId, userId)))
				.limit(1)
			if (active) {
				if (!member) {
					await app.db
						.insert(projectMembers)
						.values({ projectId: connection.projectId, userId, role: connection.defaultRole })
				}
			} else {
				if (member) {
					await app.db.delete(projectMembers).where(eq(projectMembers.id, member.id))
				}
				await revokeAllUserRefreshTokens(app.db, userId)
			}

			app.events.emit({
				type: 'scim:user_created',
				data: { userId, connectionId: connection.id, email: userName },
				timestamp: new Date().toISOString(),
			})

			const row = await fetchProvisionedUser(app, connection, userId)
			return reply.status(201).send(row ? toScimUser(row) : {})
		},
	)

	// PATCH — we honor Replace-style operations on {active, name, displayName, emails[0].value}
	app.patch<{ Params: { slug: string; id: string }; Body: { Operations?: Array<{ op: string; path?: string; value: unknown }> } }>(
		'/:slug/v2/Users/:id',
		{ preHandler },
		async (request, reply) => {
			const connection = (request as unknown as { scimConnection: typeof ssoConnections.$inferSelect }).scimConnection
			const ops = request.body?.Operations ?? []
			const row = await fetchProvisionedUser(app, connection, request.params.id)
			if (!row) return reply.status(404).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'User not found', status: '404' })

			const userUpdates: Record<string, unknown> = {}
			let activeTarget: boolean | null = null

			for (const op of ops) {
				const opName = (op.op || '').toLowerCase()
				const path = (op.path || '').toLowerCase()
				if (opName !== 'replace' && opName !== 'add') continue
				const val = op.value
				// { Operations: [{ op: 'replace', value: { active: false } }] } style
				if (!path && val && typeof val === 'object') {
					const v = val as Record<string, unknown>
					if (typeof v.active === 'boolean') activeTarget = v.active
					if (typeof v.displayName === 'string') userUpdates.name = v.displayName
					if (typeof v.userName === 'string') userUpdates.email = (v.userName as string).toLowerCase()
				} else if (path === 'active' && typeof val === 'boolean') {
					activeTarget = val
				} else if (path === 'displayname' && typeof val === 'string') {
					userUpdates.name = val
				} else if (path === 'username' && typeof val === 'string') {
					userUpdates.email = val.toLowerCase()
				}
			}

			if (Object.keys(userUpdates).length > 0) {
				userUpdates.updatedAt = new Date()
				await app.db.update(users).set(userUpdates).where(eq(users.id, row.userId))
			}

			if (activeTarget === false) {
				if (row.memberId) {
					await app.db.delete(projectMembers).where(eq(projectMembers.id, row.memberId))
				}
				await revokeAllUserRefreshTokens(app.db, row.userId)
				app.events.emit({
					type: 'scim:user_deactivated',
					data: { userId: row.userId, connectionId: connection.id },
					timestamp: new Date().toISOString(),
				})
			} else if (activeTarget === true && !row.memberId) {
				await app.db
					.insert(projectMembers)
					.values({ projectId: connection.projectId, userId: row.userId, role: connection.defaultRole })
			}

			app.events.emit({
				type: 'scim:user_updated',
				data: { userId: row.userId, connectionId: connection.id, active: activeTarget },
				timestamp: new Date().toISOString(),
			})

			const fresh = await fetchProvisionedUser(app, connection, row.userId)
			return fresh ? toScimUser(fresh) : {}
		},
	)

	// DELETE — deactivate: remove membership, revoke sessions, keep user row
	app.delete<{ Params: { slug: string; id: string } }>('/:slug/v2/Users/:id', { preHandler }, async (request, reply) => {
		const connection = (request as unknown as { scimConnection: typeof ssoConnections.$inferSelect }).scimConnection
		const row = await fetchProvisionedUser(app, connection, request.params.id)
		if (!row) return reply.status(404).send({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], detail: 'User not found', status: '404' })
		if (row.memberId) {
			await app.db.delete(projectMembers).where(eq(projectMembers.id, row.memberId))
		}
		await revokeAllUserRefreshTokens(app.db, row.userId)
		app.events.emit({
			type: 'scim:user_deactivated',
			data: { userId: row.userId, connectionId: connection.id },
			timestamp: new Date().toISOString(),
		})
		return reply.status(204).send()
	})
}

interface ProvisionedUserRow {
	userId: string
	email: string
	name: string
	role: string
	identityId: string
	memberRole: string | null
	memberId: string | null
}

async function fetchProvisionedUser(
	app: FastifyInstance,
	connection: typeof ssoConnections.$inferSelect,
	userId: string,
): Promise<ProvisionedUserRow | null> {
	const [row] = await app.db
		.select({
			userId: users.id,
			email: users.email,
			name: users.name,
			role: users.role,
			identityId: userIdentities.id,
			memberRole: projectMembers.role,
			memberId: projectMembers.id,
		})
		.from(userIdentities)
		.innerJoin(users, eq(users.id, userIdentities.userId))
		.leftJoin(
			projectMembers,
			and(eq(projectMembers.userId, users.id), eq(projectMembers.projectId, connection.projectId)),
		)
		.where(and(eq(userIdentities.connectionId, connection.id), eq(users.id, userId)))
		.limit(1)
	return row ?? null
}

function toScimUser(row: ProvisionedUserRow) {
	return {
		schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
		id: row.userId,
		userName: row.email,
		displayName: row.name,
		name: { formatted: row.name },
		emails: [{ value: row.email, primary: true }],
		active: Boolean(row.memberId),
		meta: { resourceType: 'User' },
	}
}

/* SCIM token CRUD — under /api/v1/ee/sso/connections/:connectionId/scim-tokens */
export async function scimTokenAdminRoutes(app: FastifyInstance) {
	const preHandler = [app.requireProject('admin'), app.requireLicense('sso')]

	app.get<{ Params: { connectionId: string } }>(
		'/:connectionId/scim-tokens',
		{ preHandler },
		async (request, reply) => {
			const [conn] = await app.db
				.select({ id: ssoConnections.id })
				.from(ssoConnections)
				.where(and(eq(ssoConnections.id, request.params.connectionId), eq(ssoConnections.projectId, request.project!.id)))
				.limit(1)
			if (!conn) return reply.status(404).send({ error: 'Not found' })
			const rows = await app.db
				.select({
					id: scimTokens.id,
					name: scimTokens.name,
					tokenPrefix: scimTokens.tokenPrefix,
					createdAt: scimTokens.createdAt,
					lastUsedAt: scimTokens.lastUsedAt,
					revokedAt: scimTokens.revokedAt,
				})
				.from(scimTokens)
				.where(eq(scimTokens.connectionId, conn.id))
			return rows
		},
	)

	app.post<{ Params: { connectionId: string }; Body: { name: string } }>(
		'/:connectionId/scim-tokens',
		{ preHandler },
		async (request, reply) => {
			const [conn] = await app.db
				.select({ id: ssoConnections.id })
				.from(ssoConnections)
				.where(and(eq(ssoConnections.id, request.params.connectionId), eq(ssoConnections.projectId, request.project!.id)))
				.limit(1)
			if (!conn) return reply.status(404).send({ error: 'Not found' })
			if (!request.body.name?.trim()) return reply.status(400).send({ error: 'Name required' })

			const rawToken = `inkscim_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`
			const tokenHash = createHash('sha256').update(rawToken).digest('hex')
			const tokenPrefix = rawToken.slice(0, 16)
			const [created] = await app.db
				.insert(scimTokens)
				.values({
					connectionId: conn.id,
					name: request.body.name.trim(),
					tokenHash,
					tokenPrefix,
					createdBy: request.user!.id,
				})
				.returning({
					id: scimTokens.id,
					name: scimTokens.name,
					tokenPrefix: scimTokens.tokenPrefix,
					createdAt: scimTokens.createdAt,
				})
			return reply.status(201).send({
				...created,
				token: rawToken,
				warning: 'Save this token now. It will not be shown again.',
			})
		},
	)

	app.delete<{ Params: { connectionId: string; id: string } }>(
		'/:connectionId/scim-tokens/:id',
		{ preHandler },
		async (request, reply) => {
			const [conn] = await app.db
				.select({ id: ssoConnections.id })
				.from(ssoConnections)
				.where(and(eq(ssoConnections.id, request.params.connectionId), eq(ssoConnections.projectId, request.project!.id)))
				.limit(1)
			if (!conn) return reply.status(404).send({ error: 'Not found' })
			await app.db
				.update(scimTokens)
				.set({ revokedAt: new Date() })
				.where(and(eq(scimTokens.id, request.params.id), eq(scimTokens.connectionId, conn.id)))
			return reply.status(204).send()
		},
	)
}
