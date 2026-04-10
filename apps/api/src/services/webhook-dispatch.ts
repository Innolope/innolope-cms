import type { FastifyInstance } from 'fastify'
import { webhooks, webhookDeliveries } from '@innolope/db'
import { eq, and, sql, lte } from 'drizzle-orm'
import { createHmac } from 'node:crypto'

export function initWebhookDispatcher(app: FastifyInstance) {
	if (!app.db) return

	// Subscribe to all CMS events and dispatch matching webhooks
	const unsubscribe = app.events.subscribe(async (event) => {
		try {
			const projectId = event.data.projectId as string | undefined
			if (!projectId) return

			const activeWebhooks = await app.db
				.select()
				.from(webhooks)
				.where(and(eq(webhooks.projectId, projectId), eq(webhooks.active, true)))

			for (const webhook of activeWebhooks) {
				const subscribedEvents = webhook.events as string[]
				if (subscribedEvents.length > 0 && !subscribedEvents.includes(event.type)) continue

				// Create delivery record and dispatch
				const [delivery] = await app.db.insert(webhookDeliveries).values({
					webhookId: webhook.id,
					event: event.type,
					payload: { type: event.type, data: event.data, timestamp: event.timestamp },
					status: 'pending',
					attempts: 0,
				}).returning()

				// Fire-and-forget delivery
				dispatchDelivery(app, webhook, delivery).catch((err) => {
					app.log.error(err, `Webhook delivery failed for ${webhook.id}`)
				})
			}
		} catch (err) {
			app.log.error(err, 'Webhook dispatch error')
		}
	})

	// Retry failed deliveries every 60 seconds, with guard against concurrent runs
	let retrying = false
	const retryInterval = setInterval(async () => {
		if (retrying) return
		retrying = true
		try {
			await retryFailedDeliveries(app)
		} catch (err) {
			app.log.error(err, 'Webhook retry error')
		} finally {
			retrying = false
		}
	}, 60_000)

	app.addHook('onClose', () => {
		clearInterval(retryInterval)
		unsubscribe()
	})
}

async function dispatchDelivery(
	app: FastifyInstance,
	webhook: { id: string; url: string; secret: string },
	delivery: { id: string; payload: Record<string, unknown>; attempts: number },
) {
	const body = JSON.stringify(delivery.payload)
	const signature = createHmac('sha256', webhook.secret).update(body).digest('hex')

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

		await app.db
			.update(webhookDeliveries)
			.set({
				status: response.ok ? 'success' : 'failed',
				statusCode: response.status,
				responseBody: responseBody.slice(0, 1000),
				attempts: delivery.attempts + 1,
				nextRetry: response.ok ? null : getNextRetry(delivery.attempts + 1),
			})
			.where(eq(webhookDeliveries.id, delivery.id))
	} catch {
		await app.db
			.update(webhookDeliveries)
			.set({
				status: 'failed',
				attempts: delivery.attempts + 1,
				responseBody: 'Connection failed',
				nextRetry: getNextRetry(delivery.attempts + 1),
			})
			.where(eq(webhookDeliveries.id, delivery.id))
	}
}

function getNextRetry(attempts: number): Date | null {
	if (attempts >= 3) return null // Give up after 3 attempts
	const delays = [60_000, 300_000, 1_800_000] // 1min, 5min, 30min
	const delay = delays[attempts - 1] || delays[delays.length - 1]
	return new Date(Date.now() + delay)
}

async function retryFailedDeliveries(app: FastifyInstance) {
	if (!app.db) return

	const pending = await app.db
		.select({
			delivery: webhookDeliveries,
			webhook: { id: webhooks.id, url: webhooks.url, secret: webhooks.secret },
		})
		.from(webhookDeliveries)
		.innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
		.where(
			and(
				eq(webhookDeliveries.status, 'failed'),
				sql`${webhookDeliveries.nextRetry} IS NOT NULL`,
				lte(webhookDeliveries.nextRetry, new Date()),
			),
		)
		.limit(50)

	for (const { delivery, webhook } of pending) {
		await dispatchDelivery(app, webhook, delivery).catch((err) => {
			app.log.error(err, `Webhook retry delivery failed for ${webhook.id}`)
		})
	}
}
