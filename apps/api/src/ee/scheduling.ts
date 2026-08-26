import { validateSchedule } from '@innolope/config'
import { collections, content } from '@innolope/db'
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { checkCollectionAccess } from '../lib/collection-access.js'
import { requestSource } from '../lib/request-source.js'
import { getUser } from '../plugins/auth.js'
import { getProject } from '../plugins/project.js'
import { syncExternalStatus } from '../services/external-content.js'

// EE Feature: Content Scheduling
// Requires license: 'scheduling'
//
// The status itself (`scheduled` + a `publishedAt`) can also be set through the
// normal content create/update endpoints — these routes are the explicit,
// single-purpose way to do it, plus the queue view the admin's dashboard uses.
// Whichever route sets it, `services/scheduled-publisher.ts` does the publishing.

const scheduleInputSchema = z.object({
	publishedAt: z.string().datetime(),
})

export async function schedulingRoutes(app: FastifyInstance) {
	// Schedule content for future publishing
	app.post<{ Params: { id: string } }>(
		'/:id/schedule',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('scheduling')] },
		async (request, reply) => {
			const parsed = scheduleInputSchema.safeParse(request.body)
			if (!parsed.success) {
				return reply.status(400).send({ error: 'publishedAt must be an ISO 8601 datetime.' })
			}
			const message = validateSchedule('scheduled', parsed.data.publishedAt)
			if (message) return reply.status(400).send({ error: message })

			const [current] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)
			if (!current) return reply.status(404).send({ error: 'Content not found' })

			const access = await checkCollectionAccess(request, current.collectionId, 'write')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })

			const publishedAt = new Date(parsed.data.publishedAt)

			// Mirror the status onto the source row so a site filtering on
			// `status = 'published'` stops showing the record the moment it is
			// scheduled — without waiting for the publisher to run.
			try {
				await syncExternalStatus(
					app,
					getProject(request).id,
					current.collectionId,
					current.externalId,
					'scheduled',
					publishedAt,
				)
			} catch (err) {
				app.log.warn(err, 'Failed to sync schedule to external DB')
				return reply.status(502).send({ error: 'Failed to sync to external database' })
			}

			const [updated] = await app.db
				.update(content)
				.set({
					status: 'scheduled',
					publishedAt,
					updatedAt: new Date(),
					updatedBy: getUser(request).id,
					updatedSource: requestSource(request),
				})
				.where(eq(content.id, request.params.id))
				.returning()

			app.events.emit({
				type: 'content:scheduled',
				data: {
					id: updated.id,
					slug: updated.slug,
					projectId: getProject(request).id,
					publishedAt: publishedAt.toISOString(),
				},
				timestamp: new Date().toISOString(),
			})

			return updated
		},
	)

	// Cancel a schedule — back to draft, publish date cleared.
	app.delete<{ Params: { id: string } }>(
		'/:id/schedule',
		{ preHandler: [app.requireProject('editor'), app.requireLicense('scheduling')] },
		async (request, reply) => {
			const [current] = await app.db
				.select()
				.from(content)
				.where(
					and(eq(content.id, request.params.id), eq(content.projectId, getProject(request).id)),
				)
				.limit(1)
			if (!current) return reply.status(404).send({ error: 'Content not found' })
			if (current.status !== 'scheduled') {
				return reply.status(409).send({ error: 'This record is not scheduled.' })
			}

			const access = await checkCollectionAccess(request, current.collectionId, 'write')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })

			try {
				await syncExternalStatus(
					app,
					getProject(request).id,
					current.collectionId,
					current.externalId,
					'draft',
					current.publishedAt,
				)
			} catch (err) {
				app.log.warn(err, 'Failed to sync unschedule to external DB')
				return reply.status(502).send({ error: 'Failed to sync to external database' })
			}

			const [updated] = await app.db
				.update(content)
				.set({
					status: 'draft',
					updatedAt: new Date(),
					updatedBy: getUser(request).id,
					updatedSource: requestSource(request),
				})
				.where(eq(content.id, request.params.id))
				.returning()
			return updated
		},
	)

	// List scheduled content — the publishing queue, soonest first.
	app.get('/scheduled', { preHandler: [app.requireProject('viewer')] }, async (request, reply) => {
		const query = z
			.object({
				collectionId: z.string().uuid().optional(),
				limit: z.coerce.number().int().min(1).max(100).default(50),
			})
			.safeParse(request.query)
		if (!query.success) return reply.status(400).send({ error: 'Invalid query' })

		const conditions = [
			eq(content.projectId, getProject(request).id),
			eq(content.status, 'scheduled'),
			isNotNull(content.publishedAt),
		]
		if (query.data.collectionId) {
			const access = await checkCollectionAccess(request, query.data.collectionId, 'read')
			if (!access.ok) return reply.status(access.status).send({ error: access.error })
			conditions.push(eq(content.collectionId, query.data.collectionId))
		}

		const rows = await app.db
			.select({
				id: content.id,
				slug: content.slug,
				collectionId: content.collectionId,
				collectionName: collections.name,
				metadata: content.metadata,
				publishedAt: content.publishedAt,
				locale: content.locale,
			})
			.from(content)
			.leftJoin(collections, eq(collections.id, content.collectionId))
			.where(and(...conditions))
			.orderBy(asc(content.publishedAt))
			.limit(query.data.limit)

		// `overdue` flags rows whose moment has passed but which the publisher
		// hasn't picked up yet — normally a sub-minute window, so a row that
		// stays overdue points at a failing external sync.
		const now = new Date()
		return {
			data: rows.map((r) => ({
				...r,
				overdue: !!r.publishedAt && r.publishedAt <= now,
			})),
		}
	})

	// Count of upcoming scheduled items — cheap enough for a dashboard badge.
	app.get('/upcoming-count', { preHandler: [app.requireProject('viewer')] }, async (request) => {
		const rows = await app.db
			.select({ id: content.id })
			.from(content)
			.where(
				and(
					eq(content.projectId, getProject(request).id),
					eq(content.status, 'scheduled'),
					gt(content.publishedAt, new Date()),
				),
			)
		return { count: rows.length }
	})
}
