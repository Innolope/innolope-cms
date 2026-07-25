/**
 * Bulk actions for the content list's multi-select.
 *
 * One endpoint rather than six, because the risky part is shared: resolving a
 * selection (explicit ids, or "everything matching the current filter") into the
 * exact set of rows that will be touched. Splitting that across endpoints would
 * mean six chances to get the scoping wrong.
 *
 * Every action is best-effort per item and reports a per-row outcome. That is a
 * deliberate departure from `POST/PUT /content/bulk`, which is all-or-nothing:
 * those import batches are authored as a unit, whereas a selection of 40 records
 * that fails on one read-only collection should still process the other 39 and
 * say which one didn't.
 */

import { collections, content, contentVersions } from '@innolope/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
	checkCollectionAccess,
	resolveReadableCollectionScope,
} from '../../lib/collection-access.js'
import { getUser } from '../../plugins/auth.js'
import { getProject } from '../../plugins/project.js'
import { type ContentFilterParams, contentFilterWhere } from '../../services/content-filter.js'
import { validateContentMetadata } from '../../services/content-validation.js'
import {
	buildExternalData,
	deleteFromExternalDb,
	insertIntoExternalDb,
	mergeExternalTimestamps,
	updateExternalDb,
} from '../../services/external-content.js'
import { applyLocalizedWrite } from '../../services/localized-fields.js'

/**
 * Ceiling on one bulk action.
 *
 * External-backed rows cost a network round trip each, so an unbounded
 * "select all matching" on a large collection would run for minutes and time out
 * halfway — leaving a partially applied action with no report. Callers that
 * exceed it are told the match count and asked to narrow the filter, which is
 * information they can act on.
 */
export const BULK_ACTION_MAX = 500

const STATUS_FOR_ACTION = {
	publish: 'published',
	unpublish: 'draft',
	archive: 'archived',
	'submit-for-review': 'pending_review',
} as const

type StatusAction = keyof typeof STATUS_FOR_ACTION
type BulkAction = StatusAction | 'delete' | 'set-field'

const ALL_ACTIONS: BulkAction[] = [
	'publish',
	'unpublish',
	'archive',
	'submit-for-review',
	'delete',
	'set-field',
]

interface BulkActionBody {
	action?: string
	ids?: unknown
	filter?: ContentFilterParams
	field?: string
	value?: unknown
}

/** Per-row outcome. `warning` marks a row that changed but needs a human to finish the job. */
interface ItemResult {
	id: string
	ok: boolean
	error?: string
	warning?: string
}

export async function contentBulkActionRoutes(app: FastifyInstance) {
	app.post('/bulk-action', { preHandler: [app.requireProject('editor')] }, async (req, reply) => {
		const body = (req.body ?? {}) as BulkActionBody
		const action = body.action as BulkAction

		if (!action || !ALL_ACTIONS.includes(action)) {
			return reply.status(400).send({ error: `action must be one of: ${ALL_ACTIONS.join(', ')}` })
		}

		// Deleting is an admin action on a single record; batching it must not be a
		// way for an editor to do what they cannot do one at a time.
		if (action === 'delete' && req.projectRole !== 'owner' && req.projectRole !== 'admin') {
			return reply.status(403).send({ error: 'Deleting content requires the admin role' })
		}
		if (action === 'publish' && !req.canPublishDirectly) {
			return reply
				.status(403)
				.send({ error: 'Direct publish not allowed — use submit-for-review instead.' })
		}
		if (action === 'submit-for-review' && !app.license.hasFeature('review-workflows')) {
			return reply.status(403).send({ error: 'Review workflows require an Innolope Pro license.' })
		}
		if (action === 'set-field') {
			if (typeof body.field !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(body.field)) {
				return reply.status(400).send({ error: 'field must be a schema field name' })
			}
		}

		const selection = await resolveSelection(app, req, body)
		if ('error' in selection) return reply.status(selection.status).send({ error: selection.error })
		if (selection.ids.length === 0) {
			return reply.send({ action, requested: 0, succeeded: 0, failed: 0, results: [] })
		}

		const results: ItemResult[] =
			action === 'delete'
				? await deleteMany(app, req, selection.ids)
				: await updateMany(app, req, selection.ids, action, body)

		const succeeded = results.filter((r) => r.ok).length
		return reply.send({
			action,
			requested: selection.ids.length,
			succeeded,
			failed: results.length - succeeded,
			results,
		})
	})
}

/**
 * Turn the request's selection into ids, scoped to the project.
 *
 * Explicit ids are intersected with the project's own rows rather than trusted —
 * an id from another project must not be actionable just because the caller
 * named it.
 */
async function resolveSelection(
	app: FastifyInstance,
	req: FastifyRequest,
	body: BulkActionBody,
): Promise<{ ids: string[] } | { error: string; status: number }> {
	const pid = getProject(req).id

	if (Array.isArray(body.ids)) {
		const ids = body.ids.filter((id): id is string => typeof id === 'string')
		if (ids.length === 0) return { ids: [] }
		if (ids.length > BULK_ACTION_MAX) {
			return {
				status: 400,
				error: `Too many records selected (${ids.length}). The maximum per action is ${BULK_ACTION_MAX}.`,
			}
		}
		const rows = await app.db
			.select({ id: content.id })
			.from(content)
			.where(and(eq(content.projectId, pid), inArray(content.id, ids)))
		return { ids: rows.map((r) => r.id) }
	}

	if (!body.filter || typeof body.filter !== 'object') {
		return { status: 400, error: 'Provide either ids or filter' }
	}

	// Same read gates as the list endpoint: a named collection must be readable,
	// and an unscoped filter is narrowed to the member's readable collections —
	// otherwise a restricted member could select (and then act on) rows the list
	// would never have shown them.
	if (body.filter.collectionId) {
		const access = await checkCollectionAccess(req, body.filter.collectionId, 'read')
		if (!access.ok) return { status: access.status, error: access.error }
	}
	let scopedCollectionIds: string[] | undefined
	if (!body.filter.collectionId) {
		const scope = await resolveReadableCollectionScope(req)
		if (scope.scoped) {
			if (scope.allowedIds.length === 0) return { ids: [] }
			scopedCollectionIds = scope.allowedIds
		}
	}

	// "Select all matching" — resolved through the same conditions the list uses,
	// so what the user saw counted is what gets acted on.
	const where = contentFilterWhere(body.filter, { projectId: pid, scopedCollectionIds })
	const [{ count }] = await app.db
		.select({ count: sql<number>`cast(count(*) as int)` })
		.from(content)
		.where(where)
	if (count > BULK_ACTION_MAX) {
		return {
			status: 400,
			error: `${count} records match this filter, which is over the ${BULK_ACTION_MAX} limit for one action. Narrow the filter and try again.`,
		}
	}
	const rows = await app.db.select({ id: content.id }).from(content).where(where)
	return { ids: rows.map((r) => r.id) }
}

/** Load the collections behind a set of rows, keyed by id, in one query. */
async function loadCollections(app: FastifyInstance, projectId: string, collectionIds: string[]) {
	if (collectionIds.length === 0) return new Map<string, typeof collections.$inferSelect>()
	const rows = await app.db
		.select()
		.from(collections)
		.where(and(eq(collections.projectId, projectId), inArray(collections.id, collectionIds)))
	return new Map(rows.map((c) => [c.id, c]))
}

/**
 * The write-access gate the single-record routes apply, evaluated once per
 * distinct collection in the selection. Rows in a denied collection become
 * failed ItemResults (per-row outcome, like every other failure here) rather
 * than failing the whole batch — a selection spanning collections should still
 * process the ones the member may write.
 */
async function deniedWriteAccess(
	req: FastifyRequest,
	collectionIds: string[],
): Promise<Map<string, string>> {
	const denied = new Map<string, string>()
	for (const id of collectionIds) {
		const access = await checkCollectionAccess(req, id, 'write')
		if (!access.ok) denied.set(id, access.error)
	}
	return denied
}

/**
 * Delete rows, cascading to the external database where one backs them.
 *
 * Mirrors the single-record delete: the CMS row goes first, and a failure to
 * remove the external document is reported as a warning rather than an error —
 * the delete did happen, but a document dangles and someone has to clear it.
 */
async function deleteMany(
	app: FastifyInstance,
	req: FastifyRequest,
	ids: string[],
): Promise<ItemResult[]> {
	const pid = getProject(req).id
	const rows = await app.db
		.select()
		.from(content)
		.where(and(eq(content.projectId, pid), inArray(content.id, ids)))
	const distinctCollectionIds = [...new Set(rows.map((r) => r.collectionId))]
	const colMap = await loadCollections(app, pid, distinctCollectionIds)
	const denied = await deniedWriteAccess(req, distinctCollectionIds)
	const results: ItemResult[] = []

	for (const row of rows) {
		const deniedError = denied.get(row.collectionId)
		if (deniedError) {
			results.push({ id: row.id, ok: false, error: deniedError })
			continue
		}
		const col = colMap.get(row.collectionId)
		if (col?.source === 'external' && col.accessMode === 'read-only') {
			results.push({ id: row.id, ok: false, error: `Collection is read-only: ${col.name}` })
			continue
		}

		const [deleted] = await app.db
			.delete(content)
			.where(and(eq(content.id, row.id), eq(content.projectId, pid)))
			.returning()
		if (!deleted) {
			results.push({ id: row.id, ok: false, error: 'Content not found' })
			continue
		}

		let warning: string | undefined
		if (deleted.externalId && col?.source === 'external' && col.accessMode === 'read-write') {
			try {
				await deleteFromExternalDb(app, pid, col, deleted.externalId)
			} catch (err) {
				app.log.error(err, 'Bulk delete: external cleanup failed')
				warning = `Deleted from the CMS, but the backing record ${deleted.externalId} in "${col.externalTable}" could not be removed: ${err instanceof Error ? err.message : String(err)}. Delete it there manually.`
			}
		}

		app.events.emit({
			type: 'content:deleted',
			data: { id: deleted.id, slug: deleted.slug, projectId: pid },
			timestamp: new Date().toISOString(),
		})
		results.push({ id: row.id, ok: true, ...(warning && { warning }) })
	}

	return results
}

/**
 * Apply a status change or a field value to each row.
 *
 * Follows the single-record update path: validate against the schema (required
 * fields only bite when the result is published), snapshot the previous version,
 * push to the external database when the collection is read-write, then write
 * the CMS row.
 */
async function updateMany(
	app: FastifyInstance,
	req: FastifyRequest,
	ids: string[],
	action: Exclude<BulkAction, 'delete'>,
	body: BulkActionBody,
): Promise<ItemResult[]> {
	const pid = getProject(req).id
	const userId = getUser(req).id
	const rows = await app.db
		.select()
		.from(content)
		.where(and(eq(content.projectId, pid), inArray(content.id, ids)))
	const distinctCollectionIds = [...new Set(rows.map((r) => r.collectionId))]
	const colMap = await loadCollections(app, pid, distinctCollectionIds)
	const denied = await deniedWriteAccess(req, distinctCollectionIds)
	const nextStatus = action === 'set-field' ? undefined : STATUS_FOR_ACTION[action as StatusAction]
	const results: ItemResult[] = []

	for (const row of rows) {
		const deniedError = denied.get(row.collectionId)
		if (deniedError) {
			results.push({ id: row.id, ok: false, error: deniedError })
			continue
		}
		const col = colMap.get(row.collectionId)
		if (col?.source === 'external' && col.accessMode === 'read-only') {
			results.push({ id: row.id, ok: false, error: `Collection is read-only: ${col.name}` })
			continue
		}
		if (nextStatus && row.status === nextStatus) {
			// Already there — count it as done rather than churning a version row.
			results.push({ id: row.id, ok: true })
			continue
		}

		try {
			const statusAfter = nextStatus ?? row.status
			let metadata = row.metadata as Record<string, unknown>
			if (action === 'set-field') {
				const incoming = applyLocalizedWrite(
					col?.fields ?? [],
					{ metadata: { [body.field as string]: body.value } },
					{ locale: row.locale, existing: metadata },
				)
				metadata = { ...metadata, ...incoming }
			}

			if (col) {
				const errors = validateContentMetadata(col.fields, metadata, {
					enforceRequired: statusAfter === 'published',
				})
				if (errors.length > 0) {
					results.push({
						id: row.id,
						ok: false,
						error: errors.map((e) => e.message).join(' '),
					})
					continue
				}
			}

			// Publishing for the first time stamps the date; nothing else moves it.
			const publishedAt =
				statusAfter === 'published' && !row.publishedAt ? new Date() : row.publishedAt

			let externalId = row.externalId
			let cachedMetadata = metadata
			if (col?.source === 'external' && col.accessMode === 'read-write' && col.externalTable) {
				const externalData = buildExternalData(col, {
					slug: row.slug,
					status: statusAfter,
					metadata,
					markdown: row.markdown,
					createdAt: row.createdAt,
					updatedAt: new Date(),
					publishedAt,
				})
				if (externalId) {
					await updateExternalDb(app, pid, col, externalId, externalData)
				} else {
					const inserted = await insertIntoExternalDb(app, pid, col, externalData)
					externalId = inserted?._id ?? null
				}
				cachedMetadata = mergeExternalTimestamps(metadata, externalData)
			}

			await app.db.insert(contentVersions).values({
				contentId: row.id,
				version: row.version,
				markdown: row.markdown,
				metadata: row.metadata,
				createdBy: userId,
			})

			await app.db
				.update(content)
				.set({
					...(nextStatus && { status: nextStatus }),
					metadata: cachedMetadata,
					version: row.version + 1,
					updatedAt: new Date(),
					publishedAt,
					...(externalId && { externalId }),
				})
				.where(and(eq(content.id, row.id), eq(content.projectId, pid)))

			app.events.emit({
				type: statusAfter === 'published' ? 'content:published' : 'content:updated',
				data: { id: row.id, slug: row.slug, version: row.version + 1, projectId: pid },
				timestamp: new Date().toISOString(),
			})
			results.push({ id: row.id, ok: true })
		} catch (err) {
			app.log.error(err, 'Bulk action failed for one item')
			results.push({
				id: row.id,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return results
}
