import type { FastifyInstance } from 'fastify'

// EE Feature: Webhooks
// Requires license: 'webhooks'

export async function webhookRoutes(app: FastifyInstance) {
	// List webhooks (admin+, project-scoped, requires license)
	app.get(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async () => {
			// TODO: Query from webhooks table
			return { data: [], message: 'Webhooks coming soon' }
		},
	)

	// Create webhook
	app.post(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			return reply.status(501).send({ message: 'Webhooks coming soon' })
		},
	)
}
