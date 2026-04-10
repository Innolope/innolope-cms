import type { FastifyInstance } from 'fastify'
import { webhooks, webhookDeliveries } from '@innolope/db'
import { eq, and, desc, sql } from 'drizzle-orm'
import { randomBytes, createHmac } from 'node:crypto'

export async function webhookRoutes(app: FastifyInstance) {
	// List webhooks (admin+, project-scoped, requires license)
	app.get(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request) => {
			const items = await app.db
				.select()
				.from(webhooks)
				.where(eq(webhooks.projectId, request.project!.id))
				.orderBy(desc(webhooks.createdAt))
			return { data: items }
		},
	)

	// Create webhook
	app.post(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const { url, events, secret, active } = request.body as {
				url: string
				events?: string[]
				secret?: string
				active?: boolean
			}

			if (!url) return reply.status(400).send({ error: 'URL is required' })

			const webhookSecret = secret || randomBytes(32).toString('hex')

			const [created] = await app.db.insert(webhooks).values({
				projectId: request.project!.id,
				url,
				secret: webhookSecret,
				events: events || [],
				active: active ?? true,
			}).returning()

			// Return the secret only on creation (never again)
			return reply.status(201).send({ ...created, secret: webhookSecret })
		},
	)

	// Update webhook
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const { url, events, active } = request.body as {
				url?: string
				events?: string[]
				active?: boolean
			}

			const [updated] = await app.db
				.update(webhooks)
				.set({
					...(url !== undefined && { url }),
					...(events !== undefined && { events }),
					...(active !== undefined && { active }),
					updatedAt: new Date(),
				})
				.where(and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, request.project!.id)))
				.returning()

			if (!updated) return reply.status(404).send({ error: 'Webhook not found' })
			return updated
		},
	)

	// Delete webhook
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const [deleted] = await app.db
				.delete(webhooks)
				.where(and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, request.project!.id)))
				.returning()

			if (!deleted) return reply.status(404).send({ error: 'Webhook not found' })
			return reply.status(204).send()
		},
	)

	// Delivery log for a webhook
	app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
		'/:id/deliveries',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			// Verify webhook belongs to this project
			const [webhook] = await app.db.select({ id: webhooks.id }).from(webhooks)
				.where(and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, request.project!.id)))
				.limit(1)
			if (!webhook) return reply.status(404).send({ error: 'Webhook not found' })

			const page = Math.max(1, Number(request.query.page) || 1)
			const limit = Math.min(Math.max(1, Number(request.query.limit) || 25), 100)
			const offset = (page - 1) * limit

			const [items, countResult] = await Promise.all([
				app.db
					.select()
					.from(webhookDeliveries)
					.where(eq(webhookDeliveries.webhookId, request.params.id))
					.orderBy(desc(webhookDeliveries.createdAt))
					.limit(limit)
					.offset(offset),
				app.db
					.select({ count: sql<number>`count(*)` })
					.from(webhookDeliveries)
					.where(eq(webhookDeliveries.webhookId, request.params.id)),
			])

			return {
				data: items,
				pagination: { page, limit, total: Number(countResult[0].count) },
			}
		},
	)

	// Test webhook
	app.post<{ Params: { id: string } }>(
		'/:id/test',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const [webhook] = await app.db
				.select()
				.from(webhooks)
				.where(and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, request.project!.id)))
				.limit(1)

			if (!webhook) return reply.status(404).send({ error: 'Webhook not found' })

			const payload = {
				type: 'webhook:test',
				data: { projectId: request.project!.id, message: 'Test webhook delivery' },
				timestamp: new Date().toISOString(),
			}

			const body = JSON.stringify(payload)
			const signature = createHmac('sha256', webhook.secret).update(body).digest('hex')

			const [delivery] = await app.db.insert(webhookDeliveries).values({
				webhookId: webhook.id,
				event: 'webhook:test',
				payload,
				status: 'pending',
				attempts: 1,
			}).returning()

			try {
				const response = await fetch(webhook.url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Webhook-Signature': signature,
						'X-Webhook-Id': webhook.id,
					},
					body,
					signal: AbortSignal.timeout(10_000),
				})

				const responseBody = await response.text().catch(() => '')
				await app.db.update(webhookDeliveries).set({
					status: response.ok ? 'success' : 'failed',
					statusCode: response.status,
					responseBody: responseBody.slice(0, 1000),
				}).where(eq(webhookDeliveries.id, delivery.id))

				return { success: response.ok, statusCode: response.status }
			} catch {
				await app.db.update(webhookDeliveries).set({
					status: 'failed',
					responseBody: 'Connection failed',
				}).where(eq(webhookDeliveries.id, delivery.id))

				return { success: false, error: 'Connection failed' }
			}
		},
	)
}
