import { projects, projectMembers, users } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'

export async function projectRoutes(app: FastifyInstance) {
	// List user's projects
	app.get('/', { preHandler: [app.authenticate] }, async (request) => {
		const memberships = await app.db
			.select({
				project: projects,
				role: projectMembers.role,
			})
			.from(projectMembers)
			.innerJoin(projects, eq(projects.id, projectMembers.projectId))
			.where(eq(projectMembers.userId, request.user!.id))

		return memberships.map((m) => ({
			...m.project,
			role: m.role,
		}))
	})

	// Get project by ID
	app.get<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('viewer')] },
		async (request) => {
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, request.params.id))
				.limit(1)

			return { ...project, role: request.projectRole }
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
				.where(eq(projectMembers.userId, request.user!.id))
			if (Number(count) >= maxProjects) {
				return reply.status(403).send({
					error: `Free plan limited to ${maxProjects} project${maxProjects > 1 ? 's' : ''}. Upgrade for more.`,
					upgradeUrl: 'https://innolope.dev/pricing',
				})
			}
		}

		const [project] = await app.db
			.insert(projects)
			.values({
				name,
				slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
				ownerId: request.user!.id,
			})
			.returning()

		// Add creator as owner member
		await app.db.insert(projectMembers).values({
			projectId: project.id,
			userId: request.user!.id,
			role: 'owner',
		})

		return reply.status(201).send(project)
	})

	// Update project
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { name, slug, settings } = request.body as {
				name?: string
				slug?: string
				settings?: Record<string, unknown>
			}

			const updates: Record<string, unknown> = { updatedAt: new Date() }
			if (name !== undefined) updates.name = name
			if (slug !== undefined) updates.slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
			if (settings !== undefined) updates.settings = settings

			const [updated] = await app.db
				.update(projects)
				.set(updates)
				.where(eq(projects.id, request.params.id))
				.returning()

			return updated
		},
	)

	// Delete project (owner only)
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('owner')] },
		async (request, reply) => {
			await app.db.delete(projects).where(eq(projects.id, request.params.id))
			return reply.status(204).send()
		},
	)

	// List project members
	app.get<{ Params: { id: string } }>(
		'/:id/members',
		{ preHandler: [app.requireProject('viewer')] },
		async (request) => {
			const members = await app.db
				.select({
					id: projectMembers.id,
					userId: projectMembers.userId,
					role: projectMembers.role,
					createdAt: projectMembers.createdAt,
					userName: users.name,
					userEmail: users.email,
				})
				.from(projectMembers)
				.innerJoin(users, eq(users.id, projectMembers.userId))
				.where(eq(projectMembers.projectId, request.params.id))

			return members
		},
	)

	// Add member
	app.post<{ Params: { id: string } }>(
		'/:id/members',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { email, role = 'viewer' } = request.body as {
				email: string
				role?: 'owner' | 'admin' | 'editor' | 'viewer'
			}

			const [user] = await app.db
				.select()
				.from(users)
				.where(eq(users.email, email))
				.limit(1)

			if (!user) {
				return reply.status(404).send({ error: 'User not found. They must register first.' })
			}

			// Check if already a member
			const existing = await app.db
				.select()
				.from(projectMembers)
				.where(and(eq(projectMembers.projectId, request.params.id), eq(projectMembers.userId, user.id)))
				.limit(1)

			let member
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

	// Update member role
	app.put<{ Params: { id: string; userId: string } }>(
		'/:id/members/:userId',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const { role } = request.body as { role: 'owner' | 'admin' | 'editor' | 'viewer' }

			const [updated] = await app.db
				.update(projectMembers)
				.set({ role })
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

	// Remove member
	app.delete<{ Params: { id: string; userId: string } }>(
		'/:id/members/:userId',
		{ preHandler: [app.requireProject('admin')] },
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
