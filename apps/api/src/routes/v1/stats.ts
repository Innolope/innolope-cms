import { content, media, apiKeys, collections, projectMembers, contentAnalytics } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { sql, desc, eq, and } from 'drizzle-orm'

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

	// Content analytics (viewer+, project-scoped)
	app.get('/analytics', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = request.project!.id
		const thirtyDaysAgo = sql`now() - interval '30 days'`

		const [topContent, topQueries, bySource] = await Promise.all([
			// Top content by reads (last 30 days)
			app.db
				.select({
					contentId: contentAnalytics.contentId,
					reads: sql<number>`count(*)`,
				})
				.from(contentAnalytics)
				.where(and(
					eq(contentAnalytics.projectId, pid),
					sql`${contentAnalytics.event} IN ('api_read', 'mcp_read')`,
					sql`${contentAnalytics.createdAt} > ${thirtyDaysAgo}`,
				))
				.groupBy(contentAnalytics.contentId)
				.orderBy(sql`count(*) desc`)
				.limit(20),

			// Top search queries with hit/miss breakdown
			app.db
				.select({
					query: contentAnalytics.query,
					total: sql<number>`count(*)`,
					hits: sql<number>`count(*) filter (where ${contentAnalytics.event} = 'search_hit')`,
					misses: sql<number>`count(*) filter (where ${contentAnalytics.event} = 'search_miss')`,
				})
				.from(contentAnalytics)
				.where(and(
					eq(contentAnalytics.projectId, pid),
					sql`${contentAnalytics.query} IS NOT NULL`,
					sql`${contentAnalytics.createdAt} > ${thirtyDaysAgo}`,
				))
				.groupBy(contentAnalytics.query)
				.orderBy(sql`count(*) desc`)
				.limit(20),

			// Reads by source
			app.db
				.select({
					source: contentAnalytics.source,
					count: sql<number>`count(*)`,
				})
				.from(contentAnalytics)
				.where(and(
					eq(contentAnalytics.projectId, pid),
					sql`${contentAnalytics.createdAt} > ${thirtyDaysAgo}`,
				))
				.groupBy(contentAnalytics.source),
		])

		// Enrich top content with titles
		const contentIds = topContent.map((c) => c.contentId).filter(Boolean) as string[]
		let contentMap: Record<string, string> = {}
		if (contentIds.length > 0) {
			const items = await app.db
				.select({ id: content.id, slug: content.slug, metadata: content.metadata })
				.from(content)
				.where(sql`${content.id} IN (${sql.join(contentIds.map((id) => sql`${id}`), sql`, `)})`)
			contentMap = Object.fromEntries(
				items.map((i) => [i.id, (i.metadata as Record<string, unknown>)?.title as string || i.slug]),
			)
		}

		return {
			topContent: topContent.map((c) => ({
				contentId: c.contentId,
				title: c.contentId ? contentMap[c.contentId] || 'Unknown' : 'Deleted',
				reads: Number(c.reads),
			})),
			topQueries: topQueries.map((q) => ({
				query: q.query,
				total: Number(q.total),
				hits: Number(q.hits),
				misses: Number(q.misses),
			})),
			bySource: bySource.map((s) => ({ source: s.source, count: Number(s.count) })),
		}
	})

	// Track analytics event (for MCP server)
	app.post('/track', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const body = request.body as Record<string, unknown>
		const validEvents = ['api_read', 'mcp_read', 'search_hit', 'search_miss'] as const
		const validSources = ['api', 'mcp', 'sdk'] as const

		const event = String(body.event || '')
		const source = String(body.source || '')
		if (!validEvents.includes(event as typeof validEvents[number])) return reply.status(400).send({ error: `event must be one of: ${validEvents.join(', ')}` })
		if (!validSources.includes(source as typeof validSources[number])) return reply.status(400).send({ error: `source must be one of: ${validSources.join(', ')}` })

		const contentId = body.contentId ? String(body.contentId) : null
		const query = body.query ? String(body.query) : null

		await app.db.insert(contentAnalytics).values({
			projectId: request.project!.id,
			contentId,
			event: event as typeof validEvents[number],
			query,
			source: source as typeof validSources[number],
		})

		// Forward to PostHog if configured
		app.posthog?.capture({
			distinctId: `project_${request.project!.id}`,
			event: event === 'mcp_read' ? 'cms_mcp_content_read' : event === 'search_hit' ? 'cms_mcp_search_hit' : event === 'search_miss' ? 'cms_mcp_search_miss' : `cms_${event}`,
			properties: {
				projectId: request.project!.id,
				contentId,
				query,
				source,
			},
		})

		return reply.status(204).send()
	})

	// Track MCP tool invocations — called by the MCP server after each tool call
	app.post('/mcp-usage', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const body = request.body as {
			tool: string
			durationMs: number
			success: boolean
			error?: string
			params?: Record<string, unknown>
		}

		if (!body.tool) return reply.status(400).send({ error: 'tool is required' })

		// Forward to PostHog
		app.posthog?.capture({
			distinctId: `project_${request.project!.id}`,
			event: 'cms_mcp_tool_called',
			properties: {
				tool: body.tool,
				duration_ms: body.durationMs || 0,
				success: body.success !== false,
				error: body.error || undefined,
				project_id: request.project!.id,
				// Include safe param summaries (no full content/markdown)
				params: sanitizeMcpParams(body.params),
				api_key_id: request.apiKeyAuth?.keyId,
			},
		})

		return reply.status(204).send()
	})
}

/** Strip large content fields from MCP tool params before sending to PostHog */
function sanitizeMcpParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!params) return undefined
	const safe: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(params)) {
		if (key === 'markdown' || key === 'content') {
			safe[key] = typeof value === 'string' ? `[${value.length} chars]` : undefined
		} else if (key === 'items' && Array.isArray(value)) {
			safe[key] = `[${value.length} items]`
		} else {
			safe[key] = value
		}
	}
	return safe
}
