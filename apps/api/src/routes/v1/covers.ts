import { collections, content, media, projects } from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getUser } from '../../plugins/auth.js'
import { resolveMediaAdapter } from '../../plugins/media.js'
import { getProject } from '../../plugins/project.js'
import {
	CoverRenderConfigError,
	DEFAULT_COVER_FORMATS,
	fetchCoverTemplate,
	renderCover,
	resolveBrowserRendering,
} from '../../services/cover-render.js'
import { updateExternalDb } from '../../services/external-content.js'

/**
 * Generated article covers.
 *
 * The design system that produces the HTML lives outside the CMS — it is
 * per-brand, not per-product — so these routes take the rendered HTML plus a
 * stage size. That keeps the CMS generic: any template that emits a self
 * contained HTML document can drive it.
 *
 * Everything here is gated on the `cover-generator` license feature.
 */

// A single render is one Browser Rendering call plus one media upload. The cap
// bounds a bulk request's blast radius; larger backfills page through it.
const MAX_BATCH = 25

interface Attribution {
	/** e.g. "Photo by X on Unsplash (url)" — must be published with the image. */
	credit?: string
	photoId?: string
	source?: string
	[key: string]: unknown
}

interface RenderBody {
	html: string
	width: number
	height: number
	deviceScaleFactor?: number
	type?: 'png' | 'jpeg'
	quality?: number
	filename?: string
	alt?: string
	attribution?: Attribution
	/** Optional write-back: set this content record's metadata field to the URL. */
	contentId?: string
	field?: string
}

export async function coverRoutes(app: FastifyInstance) {
	/** Is the feature usable for this project? Cheap, no Cloudflare call. */
	app.get(
		'/status',
		{ preHandler: [app.requireProject('viewer'), app.requireLicense('cover-generator')] },
		async (request) => {
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, getProject(request).id))
				.limit(1)
			const covers = project?.settings?.covers
			const formats = covers?.formats?.length ? covers.formats : DEFAULT_COVER_FORMATS
			try {
				const creds = await resolveBrowserRendering(app, getProject(request).id, project?.settings)
				return {
					enabled: true,
					credentialsFrom: creds.source,
					maxBatch: MAX_BATCH,
					formats,
					// The one-click button needs a template endpoint; /render (which is
					// handed HTML directly) does not. Reported separately so the UI can
					// explain which half is missing.
					templateConfigured: Boolean(covers?.templateUrl),
				}
			} catch (err) {
				return {
					enabled: false,
					reason: err instanceof Error ? err.message : 'unavailable',
					maxBatch: MAX_BATCH,
					formats,
					templateConfigured: Boolean(covers?.templateUrl),
				}
			}
		},
	)

	/**
	 * One-click generate for a single record: fetch the cover HTML from the
	 * project's template endpoint, render it, store it, and write the URL onto
	 * the record. This is what the "Generate cover" button in the editor calls.
	 */
	app.post<{ Body: { contentId: string; format?: string; field: string } }>(
		'/generate',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('cover-generator')] },
		async (request, reply) => {
			const { contentId, format, field } = request.body ?? {}
			if (!contentId || !field) {
				return reply.status(400).send({ error: 'contentId and field are required' })
			}

			const projectId = getProject(request).id
			const [project] = await app.db
				.select()
				.from(projects)
				.where(eq(projects.id, projectId))
				.limit(1)

			const cfg = project?.settings?.covers
			if (!cfg?.templateUrl) {
				return reply.status(503).send({
					error:
						'No cover template configured for this project. Set Settings → Media → ' +
						'Cover template URL to an endpoint that returns cover HTML for a slug.',
				})
			}

			const [row] = await app.db
				.select()
				.from(content)
				.where(and(eq(content.id, contentId), eq(content.projectId, projectId)))
				.limit(1)
			if (!row) return reply.status(404).send({ error: 'content not found' })
			if (!row.slug) {
				return reply
					.status(400)
					.send({ error: 'This record has no slug, so a cover cannot be generated for it.' })
			}

			const available = cfg.formats?.length ? cfg.formats : DEFAULT_COVER_FORMATS
			const stage = available.find((f: { name: string }) => f.name === format) ?? available[0]

			try {
				const html = await fetchCoverTemplate(
					cfg.templateUrl,
					{
						slug: row.slug,
						format: stage.name,
						section: (row.metadata?.section as string | undefined) ?? null,
					},
					cfg.templateToken,
				)
				const result = await renderAndStore(app, request, {
					html,
					width: stage.width,
					height: stage.height,
					type: 'jpeg',
					quality: 88,
					filename: `${row.slug}.${stage.name}.jpg`,
					attribution: { source: 'cover-generator', format: stage.name, slug: row.slug },
					contentId,
					field,
				})
				return reply.status(201).send({ ...result, format: stage.name })
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	/** Render one cover, store it, optionally write the URL onto a record. */
	app.post<{ Body: RenderBody }>(
		'/render',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('cover-generator')] },
		async (request, reply) => {
			try {
				const result = await renderAndStore(app, request, request.body)
				return reply.status(201).send(result)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	/**
	 * Render several covers in one call — the format variants of one article, or
	 * a page of a backfill.
	 *
	 * Renders are sequential on purpose. Browser Rendering bills by duration and
	 * rate-limits per account, and a bulk request firing 25 concurrent browsers
	 * would trip the limit for every other caller on the account. Each item
	 * reports its own outcome so one bad cover does not fail the batch.
	 */
	app.post<{ Body: { covers: RenderBody[] } }>(
		'/bulk',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('cover-generator')] },
		async (request, reply) => {
			const covers = request.body?.covers
			if (!Array.isArray(covers) || covers.length === 0) {
				return reply.status(400).send({ error: 'covers[] is required' })
			}
			if (covers.length > MAX_BATCH) {
				return reply
					.status(400)
					.send({ error: `covers[] is limited to ${MAX_BATCH} per request`, maxBatch: MAX_BATCH })
			}

			const results: Array<Record<string, unknown>> = []
			for (const [i, spec] of covers.entries()) {
				try {
					results.push({ index: i, ok: true, ...(await renderAndStore(app, request, spec)) })
				} catch (err) {
					results.push({
						index: i,
						ok: false,
						error: err instanceof Error ? err.message : 'render failed',
					})
				}
			}
			const failed = results.filter((r) => !r.ok).length
			// 207: some succeeded, some did not — the caller must inspect per item.
			return reply.status(failed === 0 ? 201 : 207).send({
				total: results.length,
				succeeded: results.length - failed,
				failed,
				results,
			})
		},
	)
}

/* ------------------------------------------------------------------ */

async function renderAndStore(app: FastifyInstance, req: FastifyRequest, body: RenderBody) {
	const projectId = getProject(req).id

	const [project] = await app.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	const creds = await resolveBrowserRendering(app, projectId, project?.settings)

	const image = await renderCover(creds, {
		html: body.html,
		width: body.width,
		height: body.height,
		deviceScaleFactor: body.deviceScaleFactor,
		type: body.type,
		quality: body.quality,
	})

	// Store through the project's resolved adapter — never the server-wide
	// default — so the file lands where this project's media lives.
	const resolved = await resolveMediaAdapter(project?.settings, { projectId, app })
	const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png'
	const filename = body.filename?.trim() || `cover-${Date.now()}.${ext}`
	const upload = await resolved.adapter.upload(image.buffer, filename, image.mimeType)

	const [created] = await app.db
		.insert(media)
		.values({
			projectId,
			type: 'image',
			filename: upload.filename,
			mimeType: image.mimeType,
			size: upload.size,
			url: upload.url,
			alt: body.alt || '',
			adapter: resolved.adapterName,
			origin: resolved.origin,
			externalId: upload.id,
			// The photographer credit travels with the image. Unsplash requires it
			// wherever the photo is published, and a generated composite is still a
			// publication of the source photo.
			metadata: {
				generated: 'cover',
				width: image.width,
				height: image.height,
				...(body.attribution ?? {}),
			},
			createdBy: getUser(req).id,
		})
		.returning()

	let written: { contentId: string; field: string } | null = null
	if (body.contentId && body.field) {
		await writeCoverToContent(app, projectId, body.contentId, body.field, upload.url)
		written = { contentId: body.contentId, field: body.field }
	}

	return { media: created, url: upload.url, written }
}

/**
 * Point a content record's metadata field at the generated cover.
 *
 * For external collections (the common case here — articles living in the
 * customer's own Mongo) the source database is the record of truth, so the
 * write goes there as well as to the local cache row. Writing only the cache
 * would silently lose the cover on the next sync.
 */
async function writeCoverToContent(
	app: FastifyInstance,
	projectId: string,
	contentId: string,
	field: string,
	url: string,
) {
	const [row] = await app.db
		.select()
		.from(content)
		.where(and(eq(content.id, contentId), eq(content.projectId, projectId)))
		.limit(1)
	if (!row) throw Object.assign(new Error(`content ${contentId} not found`), { statusCode: 404 })

	const metadata = { ...(row.metadata ?? {}), [field]: url }

	await app.db
		.update(content)
		.set({ metadata, updatedAt: new Date() })
		.where(eq(content.id, contentId))

	const [col] = await app.db
		.select()
		.from(collections)
		.where(eq(collections.id, row.collectionId))
		.limit(1)

	if (col?.source === 'external' && col.accessMode !== 'read-only' && row.externalId) {
		await updateExternalDb(app, projectId, col, row.externalId, { [field]: url })
	}
}

function sendError(reply: FastifyReply, err: unknown) {
	if (err instanceof CoverRenderConfigError) {
		return reply.status(503).send({ error: err.message })
	}
	const status =
		typeof err === 'object' && err !== null && 'statusCode' in err
			? Number((err as { statusCode: unknown }).statusCode) || 500
			: 500
	return reply.status(status).send({ error: err instanceof Error ? err.message : 'render failed' })
}
