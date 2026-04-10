import { content, contentAnalytics, aiSettings } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod'
import { generateEmbeddings } from '../../services/embedding.js'
import type { AiProviderConfig } from '../../services/ai.js'

const semanticSearchSchema = z.object({
	query: z.string().min(1).max(1000),
	threshold: z.number().min(0).max(1).default(0.7),
	limit: z.number().int().min(1).max(50).default(10),
	collectionId: z.string().uuid().optional(),
	hybrid: z.boolean().default(false),
})

export async function semanticSearchRoutes(app: FastifyInstance) {
	app.post('/', { preHandler: [app.requireProject('viewer'), app.requireLicense('ai-assistant')] }, async (request, reply) => {
		const params = semanticSearchSchema.parse(request.body)
		const pid = request.project!.id

		// Get OpenAI API key for embedding the query
		const [aiConfig] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, pid))
			.limit(1)

		const providers = (aiConfig?.providers || []) as AiProviderConfig[]
		const cloudMode = process.env.CLOUD_MODE === 'true'
		const openaiProvider = providers.find((p) => p.provider === 'openai' && p.enabled)
		const apiKey = cloudMode ? process.env.OPENAI_API_KEY : openaiProvider?.apiKey

		if (!apiKey) {
			return reply.status(400).send({ error: 'OpenAI API key is required for semantic search. Configure it in Settings > AI Models.' })
		}

		// Generate embedding for the query
		const [queryEmbedding] = await generateEmbeddings([params.query], apiKey)
		const vectorStr = `[${queryEmbedding.join(',')}]`

		// Build collection filter
		const collectionFilter = params.collectionId
			? sql`AND c."collectionId" = ${params.collectionId}`
			: sql``

		// Vector similarity search
		const vectorResults = await app.db.execute(sql`
			SELECT
				e."contentId",
				e."chunkText",
				e."chunkIndex",
				1 - (e.embedding <=> ${vectorStr}::vector) as similarity,
				c.slug,
				c.status,
				c.metadata,
				c."collectionId",
				c.locale,
				c.version
			FROM content_embeddings e
			JOIN content c ON c.id = e."contentId"
			WHERE c."projectId" = ${pid}
				AND 1 - (e.embedding <=> ${vectorStr}::vector) > ${params.threshold}
				${collectionFilter}
			ORDER BY e.embedding <=> ${vectorStr}::vector
			LIMIT ${params.limit}
		`) as unknown as Array<{
			contentId: string
			chunkText: string
			chunkIndex: number
			similarity: number
			slug: string
			status: string
			metadata: Record<string, unknown>
			collectionId: string
			locale: string
			version: number
		}>

		let results = vectorResults.map((r) => ({
			contentId: r.contentId,
			slug: r.slug,
			title: (r.metadata as Record<string, unknown>)?.title || r.slug,
			status: r.status,
			similarity: Number(r.similarity),
			matchedChunk: r.chunkText,
			chunkIndex: r.chunkIndex,
		}))

		// Hybrid mode: merge with keyword search results
		if (params.hybrid) {
			const escapedQuery = params.query.replace(/[%_\\]/g, '\\$&')
			const keywordConditions = [
				eq(content.projectId, pid),
				sql`(${content.markdown} ILIKE ${'%' + escapedQuery + '%'} ESCAPE '\\' OR ${content.metadata}::text ILIKE ${'%' + escapedQuery + '%'} ESCAPE '\\')`,
			]
			if (params.collectionId) keywordConditions.push(eq(content.collectionId, params.collectionId))

			const keywordResults = await app.db
				.select({ id: content.id, slug: content.slug, status: content.status, metadata: content.metadata })
				.from(content)
				.where(and(...keywordConditions))
				.limit(params.limit)

			// Merge: add keyword results not already in vector results
			const existingIds = new Set(results.map((r) => r.contentId))
			for (const kr of keywordResults) {
				if (!existingIds.has(kr.id)) {
					results.push({
						contentId: kr.id,
						slug: kr.slug,
						title: (kr.metadata as Record<string, unknown>)?.title as string || kr.slug,
						status: kr.status,
						similarity: 0, // keyword match, no vector score
						matchedChunk: '',
						chunkIndex: 0,
					})
				}
			}
		}

		// Deduplicate by contentId (keep highest similarity)
		const seen = new Map<string, typeof results[0]>()
		for (const r of results) {
			const existing = seen.get(r.contentId)
			if (!existing || r.similarity > existing.similarity) {
				seen.set(r.contentId, r)
			}
		}
		results = Array.from(seen.values()).sort((a, b) => b.similarity - a.similarity).slice(0, params.limit)

		// Track analytics
		app.db.insert(contentAnalytics).values({
			projectId: pid,
			event: results.length > 0 ? 'search_hit' : 'search_miss',
			query: params.query,
			source: 'api',
		}).catch(() => {})

		return { data: results, query: params.query }
	})

	// Manually trigger embedding for a content item
	app.post<{ Params: { id: string } }>('/embed/:id', { preHandler: [app.requireProject('editor'), app.requireLicense('ai-assistant')] }, async (request, reply) => {
		const { embedContent } = await import('../../services/embedding.js')

		const [item] = await app.db
			.select()
			.from(content)
			.where(and(eq(content.id, request.params.id), eq(content.projectId, request.project!.id)))
			.limit(1)

		if (!item) return reply.status(404).send({ error: 'Content not found' })

		const [aiConfig] = await app.db
			.select()
			.from(aiSettings)
			.where(eq(aiSettings.projectId, request.project!.id))
			.limit(1)

		const providers = (aiConfig?.providers || []) as AiProviderConfig[]
		const cloudMode = process.env.CLOUD_MODE === 'true'

		await embedContent(app, item.id, item.markdown, providers, cloudMode)

		return { success: true, contentId: item.id }
	})

	// Get embedding status for project
	app.get('/status', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const pid = request.project!.id

		const [totalContent] = await app.db
			.select({ count: sql<number>`count(*)` })
			.from(content)
			.where(eq(content.projectId, pid))

		const embeddedCount = await app.db.execute(sql`
			SELECT count(DISTINCT "contentId") as count
			FROM content_embeddings e
			JOIN content c ON c.id = e."contentId"
			WHERE c."projectId" = ${pid}
		`).catch(() => [{ count: 0 }]) as unknown as Array<{ count: number }>

		return {
			totalContent: Number(totalContent.count),
			embeddedContent: Number(embeddedCount[0]?.count || 0),
		}
	})
}
