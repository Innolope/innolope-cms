import { projects, projectMembers } from '@innolope/db'
import { eq, and } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

type ProjectRole = 'owner' | 'admin' | 'editor' | 'viewer'

const PROJECT_ROLE_HIERARCHY: Record<ProjectRole, number> = {
	owner: 4,
	admin: 3,
	editor: 2,
	viewer: 1,
}

declare module 'fastify' {
	interface FastifyRequest {
		project?: { id: string; slug: string; name: string }
		projectRole?: ProjectRole
	}
	interface FastifyInstance {
		requireProject: (
			minRole: ProjectRole,
		) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
	}
}

export const projectPlugin = fp(async (app: FastifyInstance) => {
	const requireProject =
		(minRole: ProjectRole) =>
		async (request: FastifyRequest, reply: FastifyReply) => {
			// First authenticate the user
			await app.authenticate(request, reply)
			if (reply.sent) return

			if (!request.user) {
				return reply.status(401).send({ error: 'Authentication required' })
			}

			// Resolve project from API key or header
			let projectId: string | undefined

			// If authenticated via API key, the key is project-scoped
			if (request.apiKeyAuth) {
				// API key already has projectId from the key lookup
				// We need to get it from the api_keys table
				const { apiKeys } = await import('@innolope/db')
				const [key] = await app.db
					.select({ projectId: apiKeys.projectId })
					.from(apiKeys)
					.where(eq(apiKeys.id, request.apiKeyAuth.keyId))
					.limit(1)

				if (key) projectId = key.projectId
			}

			// Check headers as fallback
			if (!projectId) {
				const headerProjectId = request.headers['x-project-id'] as string | undefined
				const headerProjectSlug = request.headers['x-project-slug'] as string | undefined

				if (headerProjectId) {
					projectId = headerProjectId
				} else if (headerProjectSlug) {
					const [proj] = await app.db
						.select({ id: projects.id })
						.from(projects)
						.where(eq(projects.slug, headerProjectSlug))
						.limit(1)
					if (proj) projectId = proj.id
				}
			}

			if (!projectId) {
				return reply.status(400).send({
					error: 'Project context required. Set X-Project-Id header or use a project-scoped API key.',
				})
			}

			// Get project details
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, projectId))
				.limit(1)

			if (!project) {
				return reply.status(404).send({ error: 'Project not found' })
			}

			// Check membership
			const [membership] = await app.db
				.select()
				.from(projectMembers)
				.where(
					and(
						eq(projectMembers.projectId, projectId),
						eq(projectMembers.userId, request.user.id),
					),
				)
				.limit(1)

			if (!membership) {
				return reply.status(403).send({ error: 'Not a member of this project' })
			}

			const userLevel = PROJECT_ROLE_HIERARCHY[membership.role as ProjectRole] || 0
			const requiredLevel = PROJECT_ROLE_HIERARCHY[minRole] || 0

			if (userLevel < requiredLevel) {
				return reply.status(403).send({ error: 'Insufficient project permissions' })
			}

			request.project = { id: project.id, slug: project.slug, name: project.name }
			request.projectRole = membership.role as ProjectRole
		}

	app.decorate('requireProject', requireProject)
})
