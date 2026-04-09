import { content, media, apiKeys, collections, projectMembers } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { sql, desc, eq } from 'drizzle-orm'

export async function statsRoutes(app: FastifyInstance) {
	// Dashboard stats (viewer+, project-scoped)
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = request.project!.id

		const [contentCount] = await app.db.select({ count: sql<number>`count(*)` }).from(content).where(eq(content.projectId, pid))
		const [publishedCount] = await app.db.select({ count: sql<number>`count(*)` }).from(content).where(sql`${content.projectId} = ${pid} AND ${content.status} = 'published'`)
		const [draftCount] = await app.db.select({ count: sql<number>`count(*)` }).from(content).where(sql`${content.projectId} = ${pid} AND ${content.status} = 'draft'`)
		const [mediaCount] = await app.db.select({ count: sql<number>`count(*)` }).from(media).where(eq(media.projectId, pid))
		const [keyCount] = await app.db.select({ count: sql<number>`count(*)` }).from(apiKeys).where(eq(apiKeys.projectId, pid))
		const [collectionCount] = await app.db.select({ count: sql<number>`count(*)` }).from(collections).where(eq(collections.projectId, pid))
		const [memberCount] = await app.db.select({ count: sql<number>`count(*)` }).from(projectMembers).where(eq(projectMembers.projectId, pid))

		return {
			content: { total: Number(contentCount.count), published: Number(publishedCount.count), draft: Number(draftCount.count) },
			media: Number(mediaCount.count),
			apiKeys: Number(keyCount.count),
			collections: Number(collectionCount.count),
			members: Number(memberCount.count),
		}
	})

	// Recent activity (viewer+, project-scoped)
	app.get('/recent', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db
			.select({ id: content.id, slug: content.slug, status: content.status, metadata: content.metadata, version: content.version, updatedAt: content.updatedAt, locale: content.locale })
			.from(content)
			.where(eq(content.projectId, request.project!.id))
			.orderBy(desc(content.updatedAt))
			.limit(20)
	})

	// Content by locale (viewer+, project-scoped)
	app.get('/by-locale', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		return app.db
			.select({ locale: content.locale, count: sql<number>`count(*)` })
			.from(content)
			.where(eq(content.projectId, request.project!.id))
			.groupBy(content.locale)
	})

	// API key usage (admin+, project-scoped)
	app.get('/api-usage', { preHandler: [app.requireProject('admin')] }, async (request) => {
		return app.db
			.select({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt })
			.from(apiKeys)
			.where(eq(apiKeys.projectId, request.project!.id))
			.orderBy(desc(apiKeys.lastUsedAt))
	})
}
