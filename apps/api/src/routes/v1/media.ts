import { media } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, desc, sql } from 'drizzle-orm'

export async function mediaRoutes(app: FastifyInstance) {
	// List media (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const { page = 1, limit = 25, type } = request.query as { page?: number; limit?: number; type?: string }
		const offset = (Number(page) - 1) * Number(limit)
		const pid = request.project!.id

		const conditions = [eq(media.projectId, pid)]
		if (type) conditions.push(eq(media.type, type as 'image' | 'video' | 'file'))

		const where = and(...conditions)

		const [items, countResult] = await Promise.all([
			app.db.select().from(media).where(where).orderBy(desc(media.createdAt)).limit(Number(limit)).offset(offset),
			app.db.select({ count: sql<number>`count(*)` }).from(media).where(where),
		])

		const total = Number(countResult[0].count)
		return {
			data: items,
			pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
		}
	})

	// Upload media (editor+, project-scoped)
	app.post('/upload', { preHandler: [app.requireProject('editor')] }, async (request, reply) => {
		const file = await request.file()
		if (!file) return reply.status(400).send({ error: 'No file provided' })

		const buffer = await file.toBuffer()
		const result = await app.media.upload(buffer, file.filename, file.mimetype)

		const type = file.mimetype.startsWith('image/')
			? 'image'
			: file.mimetype.startsWith('video/')
				? 'video'
				: 'file'

		const [created] = await app.db
			.insert(media)
			.values({
				projectId: request.project!.id,
				type,
				filename: result.filename,
				mimeType: file.mimetype,
				size: result.size,
				url: result.url,
				externalId: result.id,
				createdBy: request.user!.id,
			})
			.returning()

		return reply.status(201).send(created)
	})

	// Delete media (admin+, project-scoped)
	app.delete<{ Params: { id: string } }>('/:id', { preHandler: [app.requireProject('admin')] }, async (request, reply) => {
		const [item] = await app.db
			.select()
			.from(media)
			.where(and(eq(media.id, request.params.id), eq(media.projectId, request.project!.id)))
			.limit(1)

		if (!item) return reply.status(404).send({ error: 'Media not found' })
		if (item.externalId) await app.media.delete(item.externalId)
		await app.db.delete(media).where(eq(media.id, request.params.id))
		return reply.status(204).send()
	})
}
