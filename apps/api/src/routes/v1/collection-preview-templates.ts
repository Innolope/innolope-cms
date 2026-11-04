import { collectionPreviewTemplates, collections, content } from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { marked } from 'marked'
import { z } from 'zod'
import { checkCollectionAccess } from '../../lib/collection-access.js'
import { getUser } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'
import {
	BrowserRenderError,
	browserRendererFromEnv,
	type PageRenderer,
} from '../../services/browser-render.js'
import { expandUrlTemplate } from '../../services/indexnow.js'
import {
	capturePreviewTemplate,
	loadHtml,
	PreviewCaptureError,
} from '../../services/preview-template.js'

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z
	.object({
		url: z.string().min(1).max(8192),
		selectors: z
			.object({
				title: z.string().min(1).max(1024).optional(),
				body: z.string().min(1).max(1024).optional(),
				image: z.string().min(1).max(1024).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()

async function resolveCollection(request: FastifyRequest, reply: FastifyReply, write = false) {
	const params = paramsSchema.safeParse(request.params)
	if (!params.success) {
		reply.status(400).send({ error: 'Invalid collection id' })
		return null
	}
	const [collection] = await request.server.db
		.select()
		.from(collections)
		.where(
			and(eq(collections.id, params.data.id), eq(collections.projectId, getProject(request).id)),
		)
		.limit(1)
	if (!collection) {
		reply.status(404).send({ error: 'Collection not found' })
		return null
	}
	const access = await checkCollectionAccess(request, collection.id, write ? 'write' : 'read')
	if (!access.ok) {
		reply.status(access.status).send({ error: access.error })
		return null
	}
	return collection
}

async function recordHints(
	app: FastifyInstance,
	collection: typeof collections.$inferSelect,
	url: string,
) {
	try {
		const template = collection.settings.publicUrlTemplate?.trim()
		if (!template) return undefined
		const keys: string[] = []
		const pattern = template
			.split(/(\{(?:slug|locale|id)\})/)
			.map((part) => {
				if (/^\{(?:slug|locale|id)\}$/.test(part)) {
					const key = part.slice(1, -1)
					keys.push(key)
					return key === 'slug' ? '(.+?)' : '([^/?#]+)'
				}
				return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			})
			.join('')
		const match = new RegExp(`^${pattern}$`).exec(new URL(url).href)
		if (!match || (!keys.includes('slug') && !keys.includes('id'))) return undefined
		const values = Object.fromEntries(
			keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
		)
		const conditions = [
			eq(content.collectionId, collection.id),
			eq(content.projectId, collection.projectId),
		]
		if (values.slug) conditions.push(eq(content.slug, values.slug))
		if (values.locale) conditions.push(eq(content.locale, values.locale))
		if (values.id) {
			if (!z.string().uuid().safeParse(values.id).success) return undefined
			conditions.push(eq(content.id, values.id))
		}
		const rows = await app.db
			.select()
			.from(content)
			.where(and(...conditions))
			.limit(2)
		if (rows.length !== 1) return undefined
		const record = rows[0]
		if (new URL(expandUrlTemplate(template, record) ?? '').href !== new URL(url).href)
			return undefined
		const plain = loadHtml(marked.parse(record.markdown.slice(0, 8000), { async: false }))
			.text()
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 300)
		return {
			title: typeof record.metadata.title === 'string' ? record.metadata.title : undefined,
			bodyText: plain,
		}
	} catch {
		return undefined
	}
}

function response(row: typeof collectionPreviewTemplates.$inferSelect) {
	const { capturedBy: _actor, capturedAt, ...template } = row
	return { ...template, capturedAt: capturedAt.toISOString() }
}

export async function collectionPreviewTemplateRoutes(app: FastifyInstance) {
	// Pages built by JavaScript are loaded in Cloudflare Browser Run when a token is
	// configured; without one they fail with CLIENT_RENDERED as before.
	const browser = browserRendererFromEnv()
	const render: PageRenderer | null = browser
		? async (target, signal) => {
				const host = new URL(target).host
				try {
					const page = await browser(target, signal)
					app.log.info(
						{ host, status: page.status, browserMs: page.browserMs },
						'Preview page loaded in a browser',
					)
					return page
				} catch (error) {
					app.log.warn(
						{ host, reason: error instanceof BrowserRenderError ? error.reason : 'failed' },
						'Loading a preview page in a browser failed',
					)
					throw error
				}
			}
		: null
	app.get(
		'/:id/preview-template',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			const collection = await resolveCollection(request, reply)
			if (!collection) return
			const [row] = await app.db
				.select()
				.from(collectionPreviewTemplates)
				.where(eq(collectionPreviewTemplates.collectionId, collection.id))
			return { template: row ? response(row) : null }
		},
	)
	app.post(
		'/:id/preview-template',
		{
			preHandler: [app.requireProject('admin')],
			config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
		},
		async (request, reply) => {
			const collection = await resolveCollection(request, reply, true)
			if (!collection) return
			const parsed = bodySchema.safeParse(request.body)
			if (!parsed.success)
				return reply
					.status(400)
					.send({ error: 'Provide an article URL and optional CSS selectors.' })
			const { url, selectors } = parsed.data
			try {
				const hints = await recordHints(app, collection, url)
				const captured = await capturePreviewTemplate(url, { selectors, hints, render })
				const values = {
					...captured,
					collectionId: collection.id,
					selectors: selectors ?? null,
					capturedAt: new Date(captured.capturedAt),
					capturedBy: getUser(request).id,
				}
				const [saved] = await app.db
					.insert(collectionPreviewTemplates)
					.values(values)
					.onConflictDoUpdate({ target: collectionPreviewTemplates.collectionId, set: values })
					.returning()
				return { template: response(saved) }
			} catch (error) {
				let host = ''
				try {
					host = new URL(url).host
				} catch {
					/* Invalid URLs have no host to log. */
				}
				app.log.warn(
					{ code: error instanceof PreviewCaptureError ? error.code : 'PERSIST_FAILED', host },
					'Preview capture failed',
				)
				if (error instanceof PreviewCaptureError)
					return reply.status(error.statusCode).send({ error: error.message, code: error.code })
				return reply.status(500).send({ error: 'Could not save the preview template. Try again.' })
			}
		},
	)
	app.delete(
		'/:id/preview-template',
		{ preHandler: [app.requireProject('admin')] },
		async (request, reply) => {
			const collection = await resolveCollection(request, reply, true)
			if (!collection) return
			await app.db
				.delete(collectionPreviewTemplates)
				.where(eq(collectionPreviewTemplates.collectionId, collection.id))
			return reply.status(204).send()
		},
	)
}
