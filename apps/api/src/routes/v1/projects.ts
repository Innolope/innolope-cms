import { projectMemberCollections, projectMembers, projects, users } from '@innolope/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getUser, normalizeEmail } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'

/**
 * Reject if the URL `:id` doesn't match the project authorized by `requireProject`.
 * `requireProject` resolves the project from the X-Project-Id header / API key, not
 * the route param — without this guard a caller authorized for one project could
 * act on another by passing a different `:id`.
 */
async function assertProjectParam(request: FastifyRequest, reply: FastifyReply) {
	const paramId = (request.params as { id?: string }).id
	if (paramId && paramId !== getProject(request).id) {
		return reply.status(404).send({ error: 'Project not found' })
	}
}

export function sanitizeProject(
	project: typeof projects.$inferSelect,
	role?: string,
	canPublishDirectly?: boolean | null,
) {
	const settings = { ...((project.settings as unknown as Record<string, unknown>) || {}) }
	const externalDb = settings.externalDb as Record<string, unknown> | undefined
	if (externalDb) {
		// Strip media-storage credentials; expose only a `hasCredentials` flag.
		const mediaStorage = externalDb.mediaStorage as
			| Record<string, Record<string, unknown>>
			| undefined
		const sanitizedMedia = mediaStorage
			? Object.fromEntries(
					Object.entries(mediaStorage).map(([table, entry]) => {
						const { credentials, ...rest } = entry
						return [
							table,
							{
								...rest,
								hasCredentials: Boolean(
									credentials &&
										typeof credentials === 'object' &&
										Object.keys(credentials).length > 0,
								),
							},
						]
					}),
				)
			: undefined
		settings.externalDb = {
			...externalDb,
			connectionString: undefined,
			hasConnectionString: Boolean(externalDb.connectionString),
			...(sanitizedMedia ? { mediaStorage: sanitizedMedia } : {}),
		}
	}
	const cloudflare = settings.cloudflare as Record<string, unknown> | undefined
	if (cloudflare) {
		// Strip Cloudflare secrets; expose only "configured" flags.
		const { apiToken, r2AccessKeyId, r2SecretAccessKey, ...rest } = cloudflare
		settings.cloudflare = {
			...rest,
			hasApiToken: Boolean(apiToken),
			hasR2Credentials: Boolean(r2AccessKeyId && r2SecretAccessKey),
		}
	}
	return { ...project, settings, role, canPublishDirectly: canPublishDirectly ?? null }
}

export async function projectRoutes(app: FastifyInstance) {
	// List user's projects
	app.get('/', { preHandler: [app.authenticate] }, async (request) => {
		const memberships = await app.db
			.select({
				project: projects,
				role: projectMembers.role,
				canPublishDirectly: projectMembers.canPublishDirectly,
			})
			.from(projectMembers)
			.innerJoin(projects, eq(projects.id, projectMembers.projectId))
			.where(eq(projectMembers.userId, getUser(request).id))

		return memberships.map((m) => sanitizeProject(m.project, m.role, m.canPublishDirectly))
	})

	// Get project by ID
	app.get<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('viewer'), assertProjectParam] },
		async (request) => {
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)

			// Also surface the membership's publish permission so the editor
			// can render the right primary action without an extra round-trip.
			const [membership] = request.membershipId
				? await app.db
						.select({ canPublishDirectly: projectMembers.canPublishDirectly })
						.from(projectMembers)
						.where(eq(projectMembers.id, request.membershipId))
						.limit(1)
				: [{ canPublishDirectly: null as boolean | null }]

			return sanitizeProject(project, request.projectRole, membership?.canPublishDirectly ?? null)
		},
	)

	// Create project
	app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
		const { name, slug } = request.body as { name: string; slug: string }

		// Enforce project limit
		const maxProjects = app.license.maxProjects
		if (maxProjects > 0) {
			const [{ count }] = await app.db
				.select({ count: sql<number>`count(*)` })
				.from(projectMembers)
				.where(eq(projectMembers.userId, getUser(request).id))
			if (Number(count) >= maxProjects) {
				return reply.status(403).send({
					error: `Free plan limited to ${maxProjects} project${maxProjects > 1 ? 's' : ''}. Upgrade for more.`,
					upgradeUrl: 'https://innolope.dev/pricing',
				})
			}
		}

		// Solo projects ship with review disabled — there's nobody else to
		// review the work, so forcing the editor through a pending_review step
		// adds friction without value. Admins can toggle it on in Settings →
		// General once they invite teammates.
		const [project] = await app.db
			.insert(projects)
			.values({
				name,
				slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
				ownerId: getUser(request).id,
				settings: {
					locales: ['en'],
					defaultLocale: 'en',
					mediaAdapter: 'local',
					requireReview: false,
				},
			})
			.returning()

		// Add creator as owner member
		await app.db.insert(projectMembers).values({
			projectId: project.id,
			userId: getUser(request).id,
			role: 'owner',
		})

		return reply.status(201).send(sanitizeProject(project, 'owner'))
	})

	// Update project
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin'), assertProjectParam] },
		async (request, reply) => {
			const { name, slug, settings } = request.body as {
				name?: string
				slug?: string
				settings?: Record<string, unknown>
			}

			const [current] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			if (!current) return reply.status(404).send({ error: 'Project not found' })

			const updates: Record<string, unknown> = { updatedAt: new Date() }
			if (name !== undefined) updates.name = name
			if (slug !== undefined) updates.slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
			if (settings !== undefined) {
				const currentSettings = (current.settings as unknown as Record<string, unknown>) || {}
				const nextSettings = { ...currentSettings, ...settings }
				const currentExternalDb = currentSettings.externalDb as Record<string, unknown> | undefined
				const nextExternalDb = nextSettings.externalDb as Record<string, unknown> | undefined
				if (nextExternalDb && currentExternalDb) {
					const merged: Record<string, unknown> = { ...nextExternalDb }
					// The client only ever sees sanitized settings — restore secrets it can't resend.
					if (currentExternalDb.connectionString && !merged.connectionString) {
						merged.connectionString = currentExternalDb.connectionString
					}
					const currentMedia = currentExternalDb.mediaStorage as
						| Record<string, Record<string, unknown>>
						| undefined
					const nextMedia = merged.mediaStorage as
						| Record<string, Record<string, unknown>>
						| undefined
					if (nextMedia) {
						merged.mediaStorage = Object.fromEntries(
							Object.entries(nextMedia).map(([table, entry]) => {
								const { hasCredentials: _drop, ...rest } = entry
								const creds = rest.credentials as Record<string, unknown> | undefined
								if (
									(!creds || Object.keys(creds).length === 0) &&
									currentMedia?.[table]?.credentials
								) {
									rest.credentials = currentMedia[table].credentials
								}
								return [table, rest]
							}),
						)
					}
					nextSettings.externalDb = merged
				}
				const currentCf = currentSettings.cloudflare as Record<string, unknown> | undefined
				const nextCf = nextSettings.cloudflare as Record<string, unknown> | undefined
				if (nextCf) {
					// Drop the sanitized echo flags and restore secrets the client never saw.
					const { hasApiToken: _t, hasR2Credentials: _r, ...cf } = nextCf
					// `source: 'oauth'` marks a connection managed by the Connect flow;
					// a settings save from the form must not silently drop it.
					if (!cf.source && currentCf?.source) cf.source = currentCf.source
					if (!cf.apiToken && currentCf?.apiToken) cf.apiToken = currentCf.apiToken
					if (!cf.r2AccessKeyId && currentCf?.r2AccessKeyId) {
						cf.r2AccessKeyId = currentCf.r2AccessKeyId
					}
					if (!cf.r2SecretAccessKey && currentCf?.r2SecretAccessKey) {
						cf.r2SecretAccessKey = currentCf.r2SecretAccessKey
					}
					nextSettings.cloudflare = cf
				}
				updates.settings = nextSettings
			}

			const [updated] = await app.db
				.update(projects)
				.set(updates)
				.where(eq(projects.id, getProject(request).id))
				.returning()

			return sanitizeProject(updated, request.projectRole)
		},
	)

	// Delete project (owner only)
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('owner'), assertProjectParam] },
		async (request, reply) => {
			await app.db.delete(projects).where(eq(projects.id, request.params.id))
			return reply.status(204).send()
		},
	)

	// List project members
	app.get<{ Params: { id: string } }>(
		'/:id/members',
		{ preHandler: [app.requireProject('viewer'), assertProjectParam] },
		async (request) => {
			const members = await app.db
				.select({
					id: projectMembers.id,
					userId: projectMembers.userId,
					role: projectMembers.role,
					canPublishDirectly: projectMembers.canPublishDirectly,
					createdAt: projectMembers.createdAt,
					userName: users.name,
					userEmail: users.email,
				})
				.from(projectMembers)
				.innerJoin(users, eq(users.id, projectMembers.userId))
				.where(eq(projectMembers.projectId, request.params.id))

			// Annotate each member with their collection allowlist.
			// `collectionIds: null` ⇒ unrestricted; an array ⇒ scoped to those ids.
			// Owner/admin always report null (the table is ignored for them at access time).
			const memberIds = members.map((m) => m.id)
			const scopeRows = memberIds.length
				? await app.db
						.select({
							memberId: projectMemberCollections.memberId,
							collectionId: projectMemberCollections.collectionId,
						})
						.from(projectMemberCollections)
						.where(inArray(projectMemberCollections.memberId, memberIds))
				: []
			const byMember = new Map<string, string[]>()
			for (const row of scopeRows) {
				const arr = byMember.get(row.memberId) ?? []
				arr.push(row.collectionId)
				byMember.set(row.memberId, arr)
			}
			return members.map((m) => ({
				...m,
				collectionIds:
					m.role === 'owner' || m.role === 'admin' ? null : (byMember.get(m.id) ?? null),
			}))
		},
	)

	// Add member
	app.post<{ Params: { id: string } }>(
		'/:id/members',
		{ preHandler: [app.requireProject('admin'), assertProjectParam] },
		async (request, reply) => {
			const { email: rawEmail, role = 'viewer' } = request.body as {
				email: string
				role?: 'owner' | 'admin' | 'editor' | 'viewer'
			}

			if (!rawEmail?.trim()) return reply.status(400).send({ error: 'Email is required.' })
			const email = normalizeEmail(rawEmail)
			const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1)

			if (!user) {
				return reply.status(404).send({ error: 'User not found. They must register first.' })
			}

			// Check if already a member
			const existing = await app.db
				.select()
				.from(projectMembers)
				.where(
					and(eq(projectMembers.projectId, request.params.id), eq(projectMembers.userId, user.id)),
				)
				.limit(1)

			let member: typeof projectMembers.$inferSelect | undefined
			if (existing.length > 0) {
				;[member] = await app.db
					.update(projectMembers)
					.set({ role })
					.where(eq(projectMembers.id, existing[0].id))
					.returning()
			} else {
				;[member] = await app.db
					.insert(projectMembers)
					.values({ projectId: request.params.id, userId: user.id, role })
					.returning()
			}

			return reply.status(201).send(member)
		},
	)

	// Update member role and/or publish permission.
	// Body accepts `role` and/or `canPublishDirectly` (boolean | null). NULL
	// resets the member to the project's role-based default.
	app.put<{ Params: { id: string; userId: string } }>(
		'/:id/members/:userId',
		{ preHandler: [app.requireProject('admin'), assertProjectParam] },
		async (request, reply) => {
			const body =
				(request.body as {
					role?: 'owner' | 'admin' | 'editor' | 'viewer'
					canPublishDirectly?: boolean | null
				}) || {}

			const patch: { role?: typeof body.role; canPublishDirectly?: boolean | null } = {}
			if (body.role !== undefined) patch.role = body.role
			if (body.canPublishDirectly !== undefined) patch.canPublishDirectly = body.canPublishDirectly
			if (Object.keys(patch).length === 0) {
				return reply.status(400).send({ error: 'Provide role and/or canPublishDirectly' })
			}

			const [updated] = await app.db
				.update(projectMembers)
				.set(patch)
				.where(
					and(
						eq(projectMembers.projectId, request.params.id),
						eq(projectMembers.userId, request.params.userId),
					),
				)
				.returning()

			if (!updated) return reply.status(404).send({ error: 'Member not found' })
			return updated
		},
	)

	// Replace a member's collection allowlist. `collectionIds: null` ⇒ unrestricted
	// (clears all rows). `collectionIds: []` ⇒ no access. `collectionIds: [...]` ⇒
	// scoped to that set. Owner/admin always have full access regardless of rows.
	app.put<{ Params: { id: string; userId: string } }>(
		'/:id/members/:userId/collections',
		{ preHandler: [app.requireProject('admin'), assertProjectParam] },
		async (request, reply) => {
			const { collectionIds } = request.body as { collectionIds: string[] | null }

			const [member] = await app.db
				.select({ id: projectMembers.id, role: projectMembers.role })
				.from(projectMembers)
				.where(
					and(
						eq(projectMembers.projectId, request.params.id),
						eq(projectMembers.userId, request.params.userId),
					),
				)
				.limit(1)
			if (!member) return reply.status(404).send({ error: 'Member not found' })

			// Clear the existing scope first — simplest correct semantics for a full replace.
			await app.db
				.delete(projectMemberCollections)
				.where(eq(projectMemberCollections.memberId, member.id))

			if (Array.isArray(collectionIds) && collectionIds.length > 0) {
				await app.db
					.insert(projectMemberCollections)
					.values(collectionIds.map((cid) => ({ memberId: member.id, collectionId: cid })))
					.onConflictDoNothing()
			}

			return {
				memberId: member.id,
				collectionIds:
					member.role === 'owner' || member.role === 'admin'
						? null
						: Array.isArray(collectionIds)
							? collectionIds
							: null,
			}
		},
	)

	// Remove member
	app.delete<{ Params: { id: string; userId: string } }>(
		'/:id/members/:userId',
		{ preHandler: [app.requireProject('admin'), assertProjectParam] },
		async (request, reply) => {
			// Can't remove the owner
			const [member] = await app.db
				.select()
				.from(projectMembers)
				.where(
					and(
						eq(projectMembers.projectId, request.params.id),
						eq(projectMembers.userId, request.params.userId),
					),
				)
				.limit(1)

			if (member?.role === 'owner') {
				return reply.status(400).send({ error: 'Cannot remove the project owner' })
			}

			await app.db
				.delete(projectMembers)
				.where(
					and(
						eq(projectMembers.projectId, request.params.id),
						eq(projectMembers.userId, request.params.userId),
					),
				)

			return reply.status(204).send()
		},
	)
}
