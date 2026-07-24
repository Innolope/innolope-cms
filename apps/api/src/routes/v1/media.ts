import { media, projects } from '@innolope/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { cfImageVariants } from '../../lib/cf-images.js'
import { isCloudMode } from '../../lib/cloud-mode.js'
import { getImageDimensions, isRejectedImageMime } from '../../lib/image.js'
import { getUser } from '../../plugins/auth.js'
import {
	MediaConfigError,
	type MediaOrigin,
	mediaMaxSize,
	resolveMediaAdapter,
} from '../../plugins/media.js'
import { getProject } from '../../plugins/project.js'

/**
 * Ownership of a legacy row that predates the `origin` column: local files are
 * always the deployment's own storage; a cloud Cloudflare row whose delivery
 * URL carries the platform's account hash lives in the shared account.
 */
function inferOrigin(item: { origin: string | null; adapter: string; url: string }): MediaOrigin {
	if (item.origin === 'platform' || item.origin === 'project') return item.origin
	if (item.adapter !== 'cloudflare' || !isCloudMode()) return 'project'
	const envHash = process.env.CLOUDFLARE_IMAGES_ACCOUNT_HASH
	if (!envHash) return 'project'
	try {
		return new URL(item.url).pathname.split('/').filter(Boolean)[0] === envHash
			? 'platform'
			: 'project'
	} catch {
		return 'project'
	}
}

export async function mediaRoutes(app: FastifyInstance) {
	// Media config — returns which env vars are set (booleans only, never actual values)
	app.get('/config', { preHandler: [app.requireProject('viewer')] }, async () => {
		return {
			adapter: process.env.MEDIA_ADAPTER || 'local',
			cloudMode: isCloudMode(),
			env: {
				accountId: !!process.env.CLOUDFLARE_ACCOUNT_ID,
				apiToken: !!process.env.CLOUDFLARE_API_TOKEN,
				imagesAccountHash: !!process.env.CLOUDFLARE_IMAGES_ACCOUNT_HASH,
				r2Bucket: !!process.env.CLOUDFLARE_R2_BUCKET,
				r2AccessKeyId: !!process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
				r2SecretAccessKey: !!process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
				r2Endpoint: !!process.env.CLOUDFLARE_R2_ENDPOINT,
			},
		}
	})

	// List media (viewer+, project-scoped, Pro feature)
	// biome-ignore format: keep preHandler list on one line
	app.get('/', { preHandler: [app.requireProject('viewer'), app.requireLicense('media-integrations')] }, async (request) => {
		const {
			page = 1,
			limit = 25,
			type,
		} = request.query as { page?: number; limit?: number; type?: string }
		const offset = (Number(page) - 1) * Number(limit)
		const pid = getProject(request).id

		const conditions = [eq(media.projectId, pid)]
		if (type) conditions.push(eq(media.type, type as 'image' | 'video' | 'file'))

		const where = and(...conditions)

		const [items, countResult] = await Promise.all([
			app.db
				.select()
				.from(media)
				.where(where)
				.orderBy(desc(media.createdAt))
				.limit(Number(limit))
				.offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(media).where(where),
		])

		const total = Number(countResult[0].count)
		return {
			// Attach Cloudflare Images responsive renditions when the file is CF-Images-backed,
			// and resolve ownership for legacy rows that predate the origin column.
			data: items.map((item) => {
				const variants = cfImageVariants(item.url)
				const withOrigin = { ...item, origin: inferOrigin(item) }
				return variants ? { ...withOrigin, variants } : withOrigin
			}),
			pagination: {
				page: Number(page),
				limit: Number(limit),
				total,
				totalPages: Math.ceil(total / Number(limit)),
			},
		}
	})

	// Upload media (editor+, project-scoped, Pro feature)
	// biome-ignore format: keep preHandler list on one line
	app.post('/upload', { preHandler: [app.requireProject('editor'), app.requireLicense('media-integrations')] }, async (request, reply) => {
		const file = await request.file()
		if (!file) return reply.status(400).send({ error: 'No file provided' })

		if (isRejectedImageMime(file.mimetype)) {
			return reply.status(400).send({
				error: `Unsupported image type: ${file.mimetype}. Use JPEG, PNG, WebP, GIF or AVIF.`,
			})
		}

		let buffer: Buffer
		try {
			buffer = await file.toBuffer()
		} catch {
			return reply
				.status(400)
				.send({ error: `File exceeds the maximum size of ${mediaMaxSize()} bytes` })
		}
		if (file.file.truncated) {
			return reply
				.status(400)
				.send({ error: `File exceeds the maximum size of ${mediaMaxSize()} bytes` })
		}

		const [project] = await app.db
			.select()
			.from(projects)
			.where(eq(projects.id, getProject(request).id))
			.limit(1)

		let result: Awaited<ReturnType<typeof app.media.upload>>
		let resolved: Awaited<ReturnType<typeof resolveMediaAdapter>>
		try {
			resolved = await resolveMediaAdapter(project?.settings, {
				projectId: getProject(request).id,
			})
			result = await resolved.adapter.upload(buffer, file.filename, file.mimetype)
		} catch (err) {
			if (err instanceof MediaConfigError) {
				return reply.status(400).send({ error: err.message })
			}
			throw err
		}

		const type = file.mimetype.startsWith('image/')
			? 'image'
			: file.mimetype.startsWith('video/')
				? 'video'
				: 'file'

		const dimensions = type === 'image' ? getImageDimensions(buffer) : null

		const [created] = await app.db
			.insert(media)
			.values({
				projectId: getProject(request).id,
				type,
				filename: result.filename,
				mimeType: file.mimetype,
				size: result.size,
				url: result.url,
				adapter: resolved.adapterName,
				origin: resolved.origin,
				externalId: result.id,
				metadata: dimensions ? { width: dimensions.width, height: dimensions.height } : {},
				createdBy: getUser(request).id,
			})
			.returning()

		app.events.emit({
			type: 'media:uploaded',
			data: {
				id: created.id,
				filename: created.filename,
				type: created.type,
				projectId: getProject(request).id,
			},
			timestamp: new Date().toISOString(),
		})

		return reply.status(201).send(created)
	})

	// Update media metadata — alt text (SEO) and filename (editor+, project-scoped, Pro feature)
	app.patch<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('media-integrations')] },
		async (request, reply) => {
			const { alt, filename } = (request.body as { alt?: string; filename?: string }) || {}
			const updates: Partial<typeof media.$inferInsert> = {}
			if (alt !== undefined) updates.alt = alt
			if (typeof filename === 'string' && filename.trim()) updates.filename = filename.trim()
			if (Object.keys(updates).length === 0) {
				return reply.status(400).send({ error: 'Nothing to update' })
			}
			const [updated] = await app.db
				.update(media)
				.set(updates)
				.where(and(eq(media.id, request.params.id), eq(media.projectId, getProject(request).id)))
				.returning()
			if (!updated) return reply.status(404).send({ error: 'Media not found' })
			const variants = cfImageVariants(updated.url)
			return variants ? { ...updated, variants } : updated
		},
	)

	// Delete media (admin+, project-scoped, Pro feature)
	app.delete<{ Params: { id: string } }>(
		'/:id',
		{ preHandler: [app.requireProject('admin'), app.requireLicense('media-integrations')] },
		async (request, reply) => {
			const [item] = await app.db
				.select()
				.from(media)
				.where(and(eq(media.id, request.params.id), eq(media.projectId, getProject(request).id)))
				.limit(1)

			if (!item) return reply.status(404).send({ error: 'Media not found' })
			if (item.externalId) {
				const [project] = await app.db
					.select()
					.from(projects)
					.where(eq(projects.id, getProject(request).id))
					.limit(1)
				try {
					const { adapter } = await resolveMediaAdapter(project?.settings)
					await adapter.delete(item.externalId)
				} catch (err) {
					if (!(err instanceof MediaConfigError)) throw err
				}
			}
			await app.db.delete(media).where(eq(media.id, request.params.id))

			app.events.emit({
				type: 'media:deleted',
				data: { id: item.id, filename: item.filename, projectId: getProject(request).id },
				timestamp: new Date().toISOString(),
			})

			return reply.status(204).send()
		},
	)
}
