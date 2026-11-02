import { collections, content, externalSyncState } from '@innolope/db'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { checkCollectionAccess } from '../../lib/collection-access.js'
import { getProject } from '../../plugins/project.js'

export async function collectionEditorTools(app: FastifyInstance) {
	app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
		'/:id/tag-suggestions',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			const projectId = getProject(request).id
			const [collection] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, request.params.id), eq(collections.projectId, projectId)))
				.limit(1)
			if (!collection) return reply.status(404).send({ error: 'Collection not found' })
			const access = await checkCollectionAccess(request, collection.id, 'read')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })
			const query = z
				.string()
				.max(1024)
				.default('')
				.transform((value) => value.trim().normalize('NFKC'))
				.refine((value) => Array.from(value).length <= 120, 'Maximum 120 characters')
				.parse(request.query.q)
			if (Array.from(query).length < 3) return { suggestions: [] }
			// Search only the authorized local cache; never fan out to source DBs.
			const rows = await app.db.transaction(async (tx) => {
				await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`)
				return tx.execute<{ label: string }>(sql`
					WITH tags AS (
						SELECT btrim(tag #>> '{}') AS label
						FROM ${content}, LATERAL jsonb_array_elements(
							CASE WHEN jsonb_typeof(${content.metadata}->'tags') = 'array'
							THEN ${content.metadata}->'tags' ELSE '[]'::jsonb END
						) AS tag
						WHERE ${content.projectId} = ${projectId} AND ${content.collectionId} = ${collection.id}
						AND jsonb_typeof(tag) = 'string'
					)
					SELECT min(label) AS label FROM tags
					WHERE label <> '' AND strpos(lower(normalize(label, NFKC)), lower(${query})) > 0
					GROUP BY lower(normalize(label, NFKC))
					ORDER BY count(*) DESC, lower(normalize(label, NFKC)), min(label)
					LIMIT 10
				`)
			})
			reply.header('Cache-Control', 'no-store')
			return { suggestions: rows.map((row) => row.label) }
		},
	)

	app.get<{ Params: { id: string; contentId: string }; Querystring: { token?: string } }>(
		'/:id/sync-conflicts/:contentId',
		{ preHandler: [app.requireProject('viewer')] },
		async (request, reply) => {
			const projectId = getProject(request).id
			const [collection] = await app.db
				.select()
				.from(collections)
				.where(and(eq(collections.id, request.params.id), eq(collections.projectId, projectId)))
				.limit(1)
			if (!collection) return reply.status(404).send({ error: 'Collection not found' })
			const access = await checkCollectionAccess(request, collection.id, 'read')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })
			const token = z.string().min(1).max(256).parse(request.query.token)
			const [state] = await app.db
				.select()
				.from(externalSyncState)
				.where(eq(externalSyncState.collectionId, collection.id))
				.limit(1)
			const conflict = state?.conflicts.find((item) => item.contentId === request.params.contentId)
			if (!conflict || conflict.token !== token)
				return reply.status(409).send({
					code: 'SYNC_COMPARISON_CHANGED',
					error: 'This comparison changed. Recheck the latest changes before choosing.',
				})
			if (!conflict.fullComparison)
				return reply.status(409).send({
					code: 'SYNC_DETAILS_PENDING',
					error:
						'This older comparison contains a shortened preview. Recheck changes to load the full comparison.',
				})
			reply.header('Cache-Control', 'no-store')
			return { ...conflict, preview: false }
		},
	)
}
