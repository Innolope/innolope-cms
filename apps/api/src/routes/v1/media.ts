import { media } from '@innolope/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getImageDimensions, isRejectedImageMime } from '../../lib/image.js'
import { getUser } from '../../plugins/auth.js'
import { mediaAdapterName, mediaMaxSize } from '../../plugins/media.js'
import { getProject } from '../../plugins/project.js'

export async function mediaRoutes(app: FastifyInstance) {
	// Media config — returns which env vars are set (booleans only, never actual values)
	app.get('/config', { preHandler: [app.requireProject('viewer')] }, async () => {
		return {
			adapter: process.env.MEDIA_ADAPTER || 'local',
			cloudMode: !!process.env.CLOUD_MODE,
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
			data: items,
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

		const result = await app.media.upload(buffer, file.filename, file.mimetype)

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
				adapter: mediaAdapterName(),
				externalId: result.id,
				metadata: dimensions ? { width: dimensions.width, height: dimensions.height } : {},
				createdBy: getUser(request).id,
			})
			.returning()

		return reply.status(201).send(created)
	})

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
			if (item.externalId) await app.media.delete(item.externalId)
			await app.db.delete(media).where(eq(media.id, request.params.id))
			return reply.status(204).send()
		},
	)
}
