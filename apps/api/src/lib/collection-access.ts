import { collections, type Database, projectMemberCollections } from '@innolope/db'
import { and, eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'

/**
 * Per-member collection allowlist.
 *
 * `unrestricted: true` ⇒ no rows for this member ⇒ full access (modulo project role).
 * `unrestricted: false` ⇒ the member is scoped to exactly `allowedIds`.
 *
 * Owner/admin should short-circuit before calling this and always be treated as
 * unrestricted — the table only constrains editor/viewer roles.
 */
export interface MemberCollectionAccess {
	unrestricted: boolean
	allowedIds: Set<string>
}

export async function loadMemberCollectionAccess(
	db: Database,
	membershipId: string,
): Promise<MemberCollectionAccess> {
	const rows = await db
		.select({ collectionId: projectMemberCollections.collectionId })
		.from(projectMemberCollections)
		.where(eq(projectMemberCollections.memberId, membershipId))
	if (rows.length === 0) return { unrestricted: true, allowedIds: new Set() }
	return { unrestricted: false, allowedIds: new Set(rows.map((r) => r.collectionId)) }
}

/**
 * Build a map of `collectionName → boolean` indicating whether each collection
 * in the project is referenced as a `relationTo` target by any field on any
 * other collection. Used for both the sidebar `auto` rule and the "linked
 * targets are auto-readable" access fallback.
 */
export async function loadRelationTargets(
	db: Database,
	projectId: string,
): Promise<{
	/** Map keyed by collection name. */
	byName: Map<string, boolean>
	/** Map keyed by collection id. */
	byId: Map<string, boolean>
}> {
	const rows = await db
		.select({
			id: collections.id,
			name: collections.name,
			fields: collections.fields,
		})
		.from(collections)
		.where(eq(collections.projectId, projectId))

	const referencedNames = new Set<string>()
	for (const row of rows) {
		const fields = (row.fields ?? []) as Array<{ type?: string; relationTo?: string | null }>
		for (const f of fields) {
			if (f?.type === 'relation' && typeof f.relationTo === 'string' && f.relationTo) {
				referencedNames.add(f.relationTo)
			}
		}
	}

	const byName = new Map<string, boolean>()
	const byId = new Map<string, boolean>()
	for (const row of rows) {
		const isTarget = referencedNames.has(row.name)
		byName.set(row.name, isTarget)
		byId.set(row.id, isTarget)
	}
	return { byName, byId }
}

/**
 * Of the collections a member directly owns access to, return the ids of every
 * collection those in-scope ones reference via a `relation` field. This is the
 * "linked targets auto-readable" set — read access flows transitively for the
 * purpose of relation pickers and resolution, but never write access.
 */
export async function loadReferencedCollectionIds(
	db: Database,
	projectId: string,
	allowedIds: Set<string>,
): Promise<Set<string>> {
	if (allowedIds.size === 0) return new Set()

	const rows = await db
		.select({ id: collections.id, name: collections.name, fields: collections.fields })
		.from(collections)
		.where(eq(collections.projectId, projectId))

	const nameToId = new Map<string, string>()
	for (const r of rows) nameToId.set(r.name, r.id)

	const referenced = new Set<string>()
	for (const row of rows) {
		if (!allowedIds.has(row.id)) continue
		const fields = (row.fields ?? []) as Array<{ type?: string; relationTo?: string | null }>
		for (const f of fields) {
			if (f?.type === 'relation' && typeof f.relationTo === 'string' && f.relationTo) {
				const targetId = nameToId.get(f.relationTo)
				if (targetId) referenced.add(targetId)
			}
		}
	}
	return referenced
}

/**
 * Resolve the set of collection ids the current member may READ across a whole
 * project, for list/search/export endpoints that don't target one collection.
 *
 * Returns `{ scoped: false }` when the caller sees everything (owner/admin, or an
 * unrestricted member), and `{ scoped: true, allowedIds }` otherwise — where
 * `allowedIds` already folds in relation targets reachable from in-scope
 * collections (read access flows transitively, matching `checkCollectionAccess`).
 * An empty `allowedIds` means "no collections" and callers should return nothing.
 *
 * This is the single source of truth for multi-collection read scoping. Any list
 * endpoint that filters content by project MUST apply it, or it leaks other
 * collections' rows to a restricted member.
 */
export async function resolveReadableCollectionScope(
	request: FastifyRequest,
): Promise<{ scoped: false } | { scoped: true; allowedIds: string[] }> {
	const role = request.projectRole
	const membershipId = request.membershipId
	const projectId = request.project?.id
	if (!role || !membershipId || !projectId) {
		// No context resolved — fail closed to nothing rather than everything.
		return { scoped: true, allowedIds: [] }
	}
	if (role === 'owner' || role === 'admin') return { scoped: false }

	const db = request.server.db
	const access = await loadMemberCollectionAccess(db, membershipId)
	if (access.unrestricted) return { scoped: false }

	const referenced = await loadReferencedCollectionIds(db, projectId, access.allowedIds)
	const allowedIds = new Set([...access.allowedIds, ...referenced])
	return { scoped: true, allowedIds: [...allowedIds] }
}

/**
 * Gate access to a specific collection for the current authenticated member.
 *
 * - Owner/admin always pass.
 * - Editor/viewer pass if (a) the member is unrestricted, OR (b) the collection
 *   is in their allowlist (any mode), OR (c) `mode === 'read'` AND the
 *   collection is a relation target reachable from an in-scope collection.
 * - Write requires direct membership in the allowlist (or no allowlist at all).
 *   The `media` collection (`source === 'media'`) is implicitly writable by
 *   editor+ regardless of allowlist — uploads must always work.
 */
export async function checkCollectionAccess(
	request: FastifyRequest,
	collectionId: string,
	mode: 'read' | 'write',
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
	const role = request.projectRole
	const membershipId = request.membershipId
	const projectId = request.project?.id
	if (!role || !membershipId || !projectId) {
		return { ok: false, status: 403, error: 'Project context missing' }
	}

	// Owner/admin: always allowed.
	if (role === 'owner' || role === 'admin') return { ok: true }

	const db = request.server.db

	// Verify the collection exists and belongs to this project.
	const [coll] = await db
		.select({ id: collections.id, source: collections.source })
		.from(collections)
		.where(and(eq(collections.id, collectionId), eq(collections.projectId, projectId)))
		.limit(1)
	if (!coll) return { ok: false, status: 404, error: 'Collection not found' }

	// Media collection: always writable by editor+ for uploads.
	if (coll.source === 'media') {
		if (mode === 'read') return { ok: true }
		// 'write' on media — allowed for editor+. (viewer falls through to deny below.)
		if (role === 'editor') return { ok: true }
	}

	const access = await loadMemberCollectionAccess(db, membershipId)
	if (access.unrestricted) return { ok: true }

	if (access.allowedIds.has(collectionId)) return { ok: true }

	if (mode === 'read') {
		const referenced = await loadReferencedCollectionIds(db, projectId, access.allowedIds)
		if (referenced.has(collectionId)) return { ok: true }
	}

	return { ok: false, status: 403, error: 'You do not have access to this collection' }
}
