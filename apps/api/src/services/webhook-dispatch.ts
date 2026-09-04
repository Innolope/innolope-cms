import { createHmac } from 'node:crypto'
import { webhookDeliveries, webhooks } from '@innolope/db'
import { and, eq, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { safeFetch, validatePublicUrl } from '../adapters/connection-guard.js'
import { decryptSecret } from '../lib/crypto.js'

/** The webhook columns dispatch needs — retry queries must select all of these. */
export interface WebhookDispatchTarget {
	id: string
	url: string
	secret: string
	headersEnc?: Record<string, string> | null
	customPayload?: string | null
}

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
				const [delivery] = await app.db
					.insert(webhookDeliveries)
					.values({
						webhookId: webhook.id,
						event: event.type,
						payload: { type: event.type, data: event.data, timestamp: event.timestamp },
						status: 'pending',
						attempts: 0,
					})
					.returning()

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

/**
 * Render a custom payload template against a delivery's event payload.
 *
 * The template must be a JSON object; `{{event}}`, `{{timestamp}}` and
 * `{{data.<dot.path>}}` placeholders are substituted inside string values only,
 * on the parsed tree — the result is re-serialized, so a placeholder value can
 * never break out of its JSON string. Unresolved placeholders become ''.
 * Throws on a template that is not a JSON object.
 */
export function renderPayloadTemplate(template: string, payload: Record<string, unknown>): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(template)
	} catch {
		throw new Error('Invalid custom payload template')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Invalid custom payload template')
	}
	return JSON.stringify(substitutePlaceholders(parsed, payload))
}

function substitutePlaceholders(node: unknown, payload: Record<string, unknown>): unknown {
	if (typeof node === 'string') {
		return node.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, token: string) =>
			resolvePlaceholder(token, payload),
		)
	}
	if (Array.isArray(node)) return node.map((item) => substitutePlaceholders(item, payload))
	if (node && typeof node === 'object') {
		return Object.fromEntries(
			Object.entries(node).map(([key, value]) => [key, substitutePlaceholders(value, payload)]),
		)
	}
	return node
}

function resolvePlaceholder(token: string, payload: Record<string, unknown>): string {
	let value: unknown
	if (token === 'event') value = payload.type
	else if (token === 'timestamp') value = payload.timestamp
	else if (token.startsWith('data.')) {
		value = token
			.slice('data.'.length)
			.split('.')
			.reduce<unknown>(
				(acc, key) =>
					acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
				payload.data,
			)
	}
	if (value === undefined || value === null) return ''
	return typeof value === 'string' ? value : JSON.stringify(value)
}

export async function dispatchDelivery(
	app: FastifyInstance,
	webhook: WebhookDispatchTarget,
	delivery: { id: string; payload: Record<string, unknown>; attempts: number },
	opts?: { retry?: boolean },
) {
	const attempts = delivery.attempts + 1
	const retryAllowed = opts?.retry !== false
	const nextRetryFor = (n: number) => (retryAllowed ? getNextRetry(n) : null)

	const fail = (updates: {
		responseBody: string
		nextRetry: Date | null
		statusCode?: number
		sentBody?: string
	}) =>
		app.db
			.update(webhookDeliveries)
			.set({ status: 'failed', attempts, ...updates })
			.where(eq(webhookDeliveries.id, delivery.id))

	// SSRF guard at send time — the stored URL may resolve to a private address now
	// even if it was public when created (DNS rebind). Mark the delivery failed
	// without retry rather than firing the request.
	const urlError = await validatePublicUrl(webhook.url)
	if (urlError) {
		await fail({ responseBody: urlError, nextRetry: null })
		return
	}

	// A broken template can only be fixed by editing the webhook, so don't retry.
	let body: string
	try {
		body = webhook.customPayload
			? renderPayloadTemplate(webhook.customPayload, delivery.payload)
			: JSON.stringify(delivery.payload)
	} catch {
		await fail({ responseBody: 'Invalid custom payload template', nextRetry: null })
		return
	}

	// A decrypt failure usually means the encryption key is missing or was
	// rotated; retrying lets a restored key self-heal within the attempt cap.
	let customHeaders: Record<string, string>
	try {
		customHeaders = decryptCustomHeaders(webhook.headersEnc)
	} catch {
		await fail({
			responseBody:
				'Failed to decrypt custom headers — check SSO_ENCRYPTION_KEY / INTEGRATION_ENCRYPTION_KEY',
			nextRetry: nextRetryFor(attempts),
		})
		return
	}

	const signature = createHmac('sha256', webhook.secret).update(body).digest('hex')
	const sentBody = body.slice(0, 10_000)

	try {
		// A redirect is answered as-is (and recorded as the failure it is): a
		// signed payload must never be re-sent to a location the receiver picked.
		const response = await safeFetch(
			webhook.url,
			{
				method: 'POST',
				// Custom headers may override Content-Type (some APIs demand their own
				// media type) but never the signature/id headers receivers verify.
				headers: {
					'Content-Type': 'application/json',
					...customHeaders,
					'X-Webhook-Signature': signature,
					'X-Webhook-Id': webhook.id,
				},
				body,
				signal: AbortSignal.timeout(10_000),
			},
			{ maxRedirects: 0 },
		)

		const responseBody = await response.text().catch(() => '')

		await app.db
			.update(webhookDeliveries)
			.set({
				status: response.ok ? 'success' : 'failed',
				statusCode: response.status,
				responseBody: responseBody.slice(0, 1000),
				sentBody,
				attempts,
				nextRetry: response.ok ? null : nextRetryFor(attempts),
			})
			.where(eq(webhookDeliveries.id, delivery.id))
	} catch {
		await fail({ responseBody: 'Connection failed', sentBody, nextRetry: nextRetryFor(attempts) })
	}
}

function decryptCustomHeaders(
	headersEnc: Record<string, string> | null | undefined,
): Record<string, string> {
	if (!headersEnc) return {}
	const headers: Record<string, string> = {}
	for (const [name, encrypted] of Object.entries(headersEnc)) {
		headers[name] = decryptSecret(encrypted)
	}
	return headers
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
			webhook: {
				id: webhooks.id,
				url: webhooks.url,
				secret: webhooks.secret,
				headersEnc: webhooks.headersEnc,
				customPayload: webhooks.customPayload,
			},
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
