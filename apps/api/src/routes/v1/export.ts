import { content } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod'

const exportQuerySchema = z.object({
	format: z.enum(['jsonl', 'csv']).default('jsonl'),
	collectionId: z.string().uuid().optional(),
	status: z.enum(['draft', 'pending_review', 'published', 'archived']).optional(),
	locale: z.string().optional(),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
	fields: z.string().optional(), // comma-separated list of metadata fields to include
})

export async function exportRoutes(app: FastifyInstance) {
	app.get('/', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const params = exportQuerySchema.parse(request.query)

		const conditions = [eq(content.projectId, request.project!.id)]
		if (params.collectionId) conditions.push(eq(content.collectionId, params.collectionId))
		if (params.status) conditions.push(eq(content.status, params.status))
		if (params.locale) conditions.push(eq(content.locale, params.locale))
		if (params.startDate) conditions.push(sql`${content.createdAt} >= ${params.startDate}`)
		if (params.endDate) conditions.push(sql`${content.createdAt} <= ${params.endDate}`)

		const items = await app.db.select().from(content).where(and(...conditions))

		const fieldList = params.fields?.split(',').map((f: string) => f.trim()) || null

		const filterItem = (item: typeof items[0]) => {
			const base: Record<string, unknown> = {
				id: item.id,
				slug: item.slug,
				status: item.status,
				collectionId: item.collectionId,
				locale: item.locale,
				version: item.version,
				markdown: item.markdown,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				publishedAt: item.publishedAt,
			}

			if (fieldList) {
				// Only include specified metadata fields
				const metadata: Record<string, unknown> = {}
				for (const field of fieldList) {
					if (field in (item.metadata || {})) {
						metadata[field] = (item.metadata as Record<string, unknown>)[field]
					}
				}
				base.metadata = metadata
			} else {
				base.metadata = item.metadata
			}

			return base
		}

		if (params.format === 'csv') {
			reply.header('Content-Type', 'text/csv')
			reply.header('Content-Disposition', 'attachment; filename="export.csv"')

			if (items.length === 0) return ''

			const headers = ['id', 'slug', 'status', 'collectionId', 'locale', 'version', 'markdown', 'createdAt', 'updatedAt', 'publishedAt', 'metadata']
			const csvRows = [headers.join(',')]

			for (const item of items) {
				const filtered = filterItem(item)
				const row = headers.map((h) => {
					const val = filtered[h]
					if (val === null || val === undefined) return ''
					if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`
					const str = String(val)
					return str.includes(',') || str.includes('"') || str.includes('\n')
						? `"${str.replace(/"/g, '""')}"`
						: str
				})
				csvRows.push(row.join(','))
			}

			return csvRows.join('\n')
		}

		// Default: JSONL
		reply.header('Content-Type', 'application/x-ndjson')
		reply.header('Content-Disposition', 'attachment; filename="export.jsonl"')

		return items.map((item) => JSON.stringify(filterItem(item))).join('\n')
	})
}
