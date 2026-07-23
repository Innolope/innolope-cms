import { mcpFeedback, projects } from '@innolope/db'
import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser } from '../../plugins/auth.js'

const FEEDBACK_TYPES = ['bug', 'suggestion', 'friction'] as const

const feedbackInputSchema = z.object({
	type: z.enum(FEEDBACK_TYPES),
	tool: z.string().max(100).optional(),
	summary: z.string().min(1).max(500),
	details: z.string().max(4000).optional(),
	// Attribution only — validated for existence, never required. Feedback about
	// project discovery itself has no project context yet.
	projectId: z.string().uuid().optional(),
})

export async function feedbackRoutes(app: FastifyInstance) {
	// Agent feedback drop box (MCP report_feedback tool). Deliberately NOT
	// project-gated: any authenticated principal may file feedback.
	app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
		const input = feedbackInputSchema.parse(request.body)

		let projectId: string | null = null
		if (input.projectId) {
			const [proj] = await app.db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.id, input.projectId))
				.limit(1)
			projectId = proj?.id ?? null
		}

		const [saved] = await app.db
			.insert(mcpFeedback)
			.values({
				projectId,
				userId: getUser(request).id,
				type: input.type,
				tool: input.tool,
				summary: input.summary,
				details: input.details,
			})
			.returning({ id: mcpFeedback.id, createdAt: mcpFeedback.createdAt })

		return reply.status(201).send(saved)
	})

	// Reading the feedback log is account-admin only.
	app.get('/', { preHandler: [app.requireRole('admin')] }, async (request) => {
		const { type, limit } = request.query as { type?: string; limit?: string }
		const max = Math.min(Number(limit) || 50, 200)
		const typeFilter = FEEDBACK_TYPES.find((t) => t === type)

		const rows = await app.db
			.select()
			.from(mcpFeedback)
			.where(typeFilter ? eq(mcpFeedback.type, typeFilter) : undefined)
			.orderBy(desc(mcpFeedback.createdAt))
			.limit(max)

		return { data: rows, count: rows.length }
	})
}
