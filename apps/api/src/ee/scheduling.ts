import type { FastifyInstance } from 'fastify'

// EE Feature: Content Scheduling
// Requires license: 'scheduling'

export async function schedulingRoutes(app: FastifyInstance) {
	// Schedule content for future publishing
	app.post(
		'/:id/schedule',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('scheduling')] },
		async (request, reply) => {
			return reply.status(501).send({ message: 'Content scheduling coming soon' })
		},
	)

	// List scheduled content
	app.get(
		'/scheduled',
		{ preHandler: [app.requireProject('viewer'), app.requireLicense('scheduling')] },
		async () => {
			return { data: [], message: 'Content scheduling coming soon' }
		},
	)
}
