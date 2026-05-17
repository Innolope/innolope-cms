import type { FastifyInstance } from 'fastify'
import type { CmsEvent } from '../../plugins/events.js'
import { getProject } from '../../plugins/project.js'

export async function streamRoutes(app: FastifyInstance) {
	// SSE endpoint for real-time updates
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		reply.hijack()

		reply.raw.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		})

		// Send initial ping
		reply.raw.write(`event: ping\ndata: ${JSON.stringify({ connected: true })}\n\n`)

		const projectId = getProject(request).id

		// Subscribe to events — only forward events for this project
		const unsubscribe = app.events.subscribe((event: CmsEvent) => {
			if (event.data.projectId === projectId) {
				reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			}
		})

		// Heartbeat every 30s to keep connection alive
		const heartbeat = setInterval(() => {
			reply.raw.write(`: heartbeat\n\n`)
		}, 30000)

		// Cleanup on disconnect
		let cleaned = false
		const cleanup = () => {
			if (cleaned) return
			cleaned = true
			unsubscribe()
			clearInterval(heartbeat)
		}
		request.raw.on('close', cleanup)
		reply.raw.on('close', cleanup)
	})
}
