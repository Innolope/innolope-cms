import { randomBytes } from 'node:crypto'
import { webhookDeliveries, webhooks } from '@innolope/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { validatePublicUrl } from '../adapters/connection-guard.js'
import { encryptSecret } from '../lib/crypto.js'
import { getProject } from '../plugins/project.js'
import { dispatchDelivery } from '../services/webhook-dispatch.js'

/** Minimum entropy (hex chars) for a caller-supplied webhook signing secret. */
const MIN_WEBHOOK_SECRET_LENGTH = 32

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/

// Names the dispatcher owns (signature/id) or that would corrupt the request.
const FORBIDDEN_HEADER_NAMES = new Set([
	'host',
	'content-length',
	'transfer-encoding',
	'connection',
	'x-webhook-signature',
	'x-webhook-id',
])

const headersSchema = z
	.record(z.string(), z.string().min(1).max(2048))
	.superRefine((headers, ctx) => {
		const names = Object.keys(headers)
		if (names.length > 20) {
			ctx.addIssue({ code: 'custom', message: 'At most 20 custom headers are allowed.' })
		}
		for (const name of names) {
			if (!HEADER_NAME_PATTERN.test(name)) {
				ctx.addIssue({
					code: 'custom',
					message: `Invalid header name "${name}" — use letters, digits and hyphens.`,
				})
			} else if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
				ctx.addIssue({ code: 'custom', message: `The "${name}" header cannot be customized.` })
			}
		}
	})

const customPayloadSchema = z
	.string()
	.max(8192, 'Custom payload template must be at most 8 KB.')
	.refine((value) => {
		try {
			const parsed = JSON.parse(value)
			return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
		} catch {
			return false
		}
	}, 'Custom payload must be a valid JSON object.')

export const createWebhookSchema = z.object({
	url: z.string().min(1, 'URL is required'),
	events: z.array(z.string()).optional(),
	secret: z.string().optional(),
	active: z.boolean().optional(),
	headers: headersSchema.optional(),
	customPayload: customPayloadSchema.nullish(),
})

// undefined = leave unchanged; null (or {} for headers) = clear.
export const updateWebhookSchema = z.object({
	url: z.string().min(1).optional(),
	events: z.array(z.string()).optional(),
	active: z.boolean().optional(),
	headers: headersSchema.nullish(),
	customPayload: customPayloadSchema.nullish(),
})

/**
 * Strip everything secret from a webhook row: the signing secret and the
 * encrypted header values. Callers get the header names so the UI can show
 * what's configured without ever seeing a value again.
 */
export function sanitizeWebhook<
	T extends { secret: string; headersEnc?: Record<string, string> | null },
>(webhook: T): Omit<T, 'secret' | 'headersEnc'> & { headerNames: string[] } {
	const { secret: _secret, headersEnc, ...rest } = webhook
	return { ...rest, headerNames: headersEnc ? Object.keys(headersEnc) : [] }
}

function encryptHeaders(headers: Record<string, string>): Record<string, string> {
	const encrypted: Record<string, string> = {}
	for (const [name, value] of Object.entries(headers)) {
		encrypted[name] = encryptSecret(value)
	}
	return encrypted
}

const MISSING_KEY_ERROR =
	'This server has no encryption key configured (set SSO_ENCRYPTION_KEY or INTEGRATION_ENCRYPTION_KEY) — required to store custom headers.'

export async function webhookRoutes(app: FastifyInstance) {
	// List webhooks (admin+, project-scoped, requires license)
	app.get(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request) => {
			const items = await app.db
				.select()
				.from(webhooks)
				.where(eq(webhooks.projectId, getProject(request).id))
				.orderBy(desc(webhooks.createdAt))
			return { data: items.map(sanitizeWebhook) }
		},
	)

	// Create webhook
	app.post(
		'/',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const parsed = createWebhookSchema.safeParse(request.body)
			if (!parsed.success) {
				return reply.status(400).send({ error: parsed.error.issues[0].message })
			}
			const { url, events, secret, active, headers, customPayload } = parsed.data

			const urlError = await validatePublicUrl(url)
			if (urlError) return reply.status(400).send({ error: urlError })

			if (secret !== undefined && secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
				return reply.status(400).send({
					error: `Webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`,
				})
			}
			const webhookSecret = secret || randomBytes(32).toString('hex')

			let headersEnc: Record<string, string> | null = null
			if (headers && Object.keys(headers).length > 0) {
				try {
					headersEnc = encryptHeaders(headers)
				} catch {
					return reply.status(400).send({ error: MISSING_KEY_ERROR })
				}
			}

			const [created] = await app.db
				.insert(webhooks)
				.values({
					projectId: getProject(request).id,
					url,
					secret: webhookSecret,
					events: events || [],
					headersEnc,
					customPayload: customPayload ?? null,
					active: active ?? true,
				})
				.returning()

			// Return the secret only on creation (never again)
			return reply.status(201).send({ ...sanitizeWebhook(created), secret: webhookSecret })
		},
	)

	// Update webhook
	app.put<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const parsed = updateWebhookSchema.safeParse(request.body)
			if (!parsed.success) {
				return reply.status(400).send({ error: parsed.error.issues[0].message })
			}
			const { url, events, active, headers, customPayload } = parsed.data

			if (url !== undefined) {
				const urlError = await validatePublicUrl(url)
				if (urlError) return reply.status(400).send({ error: urlError })
			}

			// Headers replace as a whole map: values are write-only, so a partial
			// merge could never round-trip through the UI.
			let headersUpdate: { headersEnc: Record<string, string> | null } | undefined
			if (headers !== undefined) {
				if (headers === null || Object.keys(headers).length === 0) {
					headersUpdate = { headersEnc: null }
				} else {
					try {
						headersUpdate = { headersEnc: encryptHeaders(headers) }
					} catch {
						return reply.status(400).send({ error: MISSING_KEY_ERROR })
					}
				}
			}

			const [updated] = await app.db
				.update(webhooks)
				.set({
					...(url !== undefined && { url }),
					...(events !== undefined && { events }),
					...(active !== undefined && { active }),
					...headersUpdate,
					...(customPayload !== undefined && { customPayload }),
					updatedAt: new Date(),
				})
				.where(
					and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, getProject(request).id)),
				)
				.returning()

			if (!updated) return reply.status(404).send({ error: 'Webhook not found' })
			return sanitizeWebhook(updated)
		},
	)

	// Delete webhook
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const [deleted] = await app.db
				.delete(webhooks)
				.where(
					and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, getProject(request).id)),
				)
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
			const [webhook] = await app.db
				.select({ id: webhooks.id })
				.from(webhooks)
				.where(
					and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, getProject(request).id)),
				)
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

	// Test webhook — same pipeline as real deliveries (custom headers and payload
	// apply), but failures are not retried.
	app.post<{ Params: { id: string } }>(
		'/:id/test',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('webhooks')] },
		async (request, reply) => {
			const [webhook] = await app.db
				.select()
				.from(webhooks)
				.where(
					and(eq(webhooks.id, request.params.id), eq(webhooks.projectId, getProject(request).id)),
				)
				.limit(1)

			if (!webhook) return reply.status(404).send({ error: 'Webhook not found' })

			// Re-validate at send time: a hostname that was public at create time can
			// later resolve to a private address (DNS rebind).
			const urlError = await validatePublicUrl(webhook.url)
			if (urlError) return reply.status(400).send({ error: urlError })

			const payload = {
				type: 'webhook:test',
				data: { projectId: getProject(request).id, message: 'Test webhook delivery' },
				timestamp: new Date().toISOString(),
			}

			const [delivery] = await app.db
				.insert(webhookDeliveries)
				.values({
					webhookId: webhook.id,
					event: 'webhook:test',
					payload,
					status: 'pending',
					attempts: 0,
				})
				.returning()

			await dispatchDelivery(app, webhook, delivery, { retry: false })

			const [result] = await app.db
				.select()
				.from(webhookDeliveries)
				.where(eq(webhookDeliveries.id, delivery.id))
				.limit(1)

			if (result?.status === 'success') {
				return { success: true, statusCode: result.statusCode }
			}
			return {
				success: false,
				...(result?.statusCode != null && { statusCode: result.statusCode }),
				error: result?.responseBody || 'Connection failed',
			}
		},
	)
}
