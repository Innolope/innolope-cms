import type { CollectionField } from '@innolope/config'
import { collections, content, media } from '@innolope/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

/** A `media` row reshaped like a content item so relation fields resolve uniformly. */
export function mediaRowToContentItem(m: typeof media.$inferSelect) {
	const meta = (m.metadata as Record<string, unknown>) || {}
	return {
		id: m.id,
		metadata: {
			url: m.url,
			filename: m.filename,
			alt: m.alt,
			type: m.type,
			mimeType: m.mimeType,
			size: m.size,
			width: meta.width ?? null,
			height: meta.height ?? null,
		},
		createdAt: m.createdAt,
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ContentItem = Record<string, unknown> & { metadata?: Record<string, unknown> }

/**
 * Replace `relation` field UUIDs in each item's `metadata` with the resolved record.
 * Resolves one level (depth >= 1). Records that can't be found are left as the raw id.
 */
export async function resolveRelations(
	app: FastifyInstance,
	projectId: string,
	items: ContentItem[],
	fields: CollectionField[],
	depth: number,
): Promise<void> {
	if (depth < 1 || items.length === 0) return
	const relationFields = fields.filter((f) => f.type === 'relation' && f.relationTo)
	if (relationFields.length === 0) return

	// Gather distinct ids per relationTo target.
	const idsByTarget = new Map<string, Set<string>>()
	for (const item of items) {
		const meta = item.metadata
		if (!meta) continue
		for (const f of relationFields) {
			const raw = meta[f.name]
			const values = Array.isArray(raw) ? raw : [raw]
			for (const v of values) {
				if (typeof v === 'string' && UUID_RE.test(v)) {
					const set = idsByTarget.get(f.relationTo as string) ?? new Set<string>()
					set.add(v)
					idsByTarget.set(f.relationTo as string, set)
				}
			}
		}
	}
	if (idsByTarget.size === 0) return

	// Resolve each target to a map of id -> resolved record.
	const resolved = new Map<string, Map<string, unknown>>()
	for (const [target, ids] of idsByTarget) {
		const idList = [...ids]
		const recordMap = new Map<string, unknown>()
		const [col] = await app.db
			.select()
			.from(collections)
			.where(and(eq(collections.name, target), eq(collections.projectId, projectId)))
			.limit(1)
		if (col?.source === 'media') {
			const rows = await app.db
				.select()
				.from(media)
				.where(and(eq(media.projectId, projectId), inArray(media.id, idList)))
			for (const row of rows) recordMap.set(row.id, mediaRowToContentItem(row))
		} else if (col) {
			const rows = await app.db
				.select()
				.from(content)
				.where(
					and(
						eq(content.projectId, projectId),
						eq(content.collectionId, col.id),
						inArray(content.id, idList),
					),
				)
			for (const row of rows) recordMap.set(row.id, row)
		}
		resolved.set(target, recordMap)
	}

	// Substitute resolved records back into each item's metadata.
	for (const item of items) {
		const meta = item.metadata
		if (!meta) continue
		const next = { ...meta }
		for (const f of relationFields) {
			const recordMap = resolved.get(f.relationTo as string)
			if (!recordMap) continue
			const raw = meta[f.name]
			if (Array.isArray(raw)) {
				next[f.name] = raw.map((v) =>
					typeof v === 'string' && recordMap.has(v) ? recordMap.get(v) : v,
				)
			} else if (typeof raw === 'string' && recordMap.has(raw)) {
				next[f.name] = recordMap.get(raw)
			}
		}
		item.metadata = next
	}
}
