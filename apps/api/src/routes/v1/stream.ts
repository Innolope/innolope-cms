import type { FastifyInstance } from 'fastify'
import type { CmsEvent } from '../../plugins/events.js'

export async function streamRoutes(app: FastifyInstance) {
	// SSE endpoint for real-time updates
	app.get('/', { preHandler: [app.requireRole('viewer')] }, async (request, reply) => {
		reply.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		})

		// Send initial ping
		reply.raw.write(`event: ping\ndata: ${JSON.stringify({ connected: true })}\n\n`)

		// Subscribe to events
		const unsubscribe = app.events.subscribe((event: CmsEvent) => {
			reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		})

		// Heartbeat every 30s to keep connection alive
		const heartbeat = setInterval(() => {
			reply.raw.write(`: heartbeat\n\n`)
		}, 30000)

		// Cleanup on disconnect
		request.raw.on('close', () => {
			unsubscribe()
			clearInterval(heartbeat)
		})
	})
}
