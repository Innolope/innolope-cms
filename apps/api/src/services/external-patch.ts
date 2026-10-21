/**
 * Patch semantics for writes to an external database.
 *
 * Every cached external row keeps `externalSnapshot`, the source row as the CMS
 * last observed it. An update is built against that snapshot and sends only the
 * keys the edit actually changed:
 *
 *  - A column the edit did not touch is never rewritten. That matters because the
 *    cache is JSON: a nested ObjectId, a nested Date or a Decimal128 survives it
 *    only as a string or an `{ $numberDecimal }` object, and writing that copy back
 *    corrupts the source type even though nobody changed the value.
 *  - On MongoDB the diff descends into plain objects and emits dotted paths, so a
 *    one-language edit of a `{ en, uk }` map sets `title.en` and nothing else, and
 *    an edit of one key of an embedded document leaves its siblings alone.
 *  - Another client's change to a column the editor never touched survives the
 *    save instead of being reverted to the cached value.
 *
 * A save that changes nothing produces an empty patch and no write at all.
 */

import type { CollectionField } from '@innolope/config'
import { BODY_FIELD_NAMES } from './localized-fields.js'
import { type SyncState, stableValue } from './sync-state.js'

export interface ExternalPatch {
	/** Keys to write. On MongoDB a key may be a dotted path into a sub-document. */
	set: Record<string, unknown>
	/** Keys to remove: `$unset` on MongoDB, NULL on SQL targets. */
	unset: string[]
}

export function isEmptyPatch(patch: ExternalPatch): boolean {
	return Object.keys(patch.set).length === 0 && patch.unset.length === 0
}

/**
 * The source row as the CMS last observed it, keyed the way `buildExternalData`
 * keys its output. The snapshot keeps every source column in `metadata` except
 * the body, which a plain-string body leaves only in `markdown`.
 */
export function externalBaseline(
	fields: CollectionField[] | null | undefined,
	snapshot: SyncState,
): Record<string, unknown> {
	const baseline: Record<string, unknown> = { ...snapshot.metadata }
	const declared = new Set((fields ?? []).map((field) => field.name))
	const bodyField = BODY_FIELD_NAMES.find((name) => declared.has(name))
	if (bodyField && !(bodyField in baseline)) baseline[bodyField] = snapshot.markdown
	return baseline
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * A key MongoDB can address as one segment of a dotted path. A key with a dot in
 * it, or an operator-looking `$` key (how an `{ $numberDecimal }` copy arrives
 * from the cache), cannot be patched by path, so its parent is written whole.
 */
function isPathSafeKey(key: string): boolean {
	return key.length > 0 && !key.includes('.') && !key.startsWith('$')
}

function diffValue(
	patch: ExternalPatch,
	path: string,
	next: unknown,
	before: unknown,
	nested: boolean,
): void {
	if (next === undefined) return
	if (stableValue(next) === stableValue(before)) return
	if (
		nested &&
		isPlainObject(next) &&
		isPlainObject(before) &&
		Object.keys(next).length > 0 &&
		Object.keys(next).every(isPathSafeKey) &&
		Object.keys(before).every(isPathSafeKey)
	) {
		for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
			const childPath = `${path}.${key}`
			if (!(key in next) || next[key] === undefined) {
				// The editor emits the whole object, so a key it left out was removed —
				// the same outcome the old whole-object rewrite had, minus the siblings.
				if (before[key] !== undefined) patch.unset.push(childPath)
				continue
			}
			diffValue(patch, childPath, next[key], before[key], nested)
		}
		return
	}
	patch.set[path] = next
}

/**
 * Diff an outgoing payload against the last observed source row.
 *
 * `unset` names top-level keys the caller explicitly removed (an update that sent
 * `null` for them). They are the only top-level keys that can be removed: a key
 * that is merely absent from the cached metadata is not a removal — a column the
 * source filled with a default on insert never reached the cache, and treating
 * its absence as intent would wipe it on the next unrelated edit.
 */
export function diffExternalPayload(
	next: Record<string, unknown>,
	baseline: Record<string, unknown>,
	opts: { nested: boolean; unset?: string[] },
): ExternalPatch {
	const patch: ExternalPatch = { set: {}, unset: [] }
	for (const [key, value] of Object.entries(next)) {
		diffValue(patch, key, value, baseline[key], opts.nested)
	}
	for (const key of opts.unset ?? []) {
		if (key in next && next[key] !== null && next[key] !== undefined) continue
		if (baseline[key] === undefined || baseline[key] === null) continue
		patch.unset.push(key)
	}
	return patch
}

/** A whole payload as a patch — used when there is no snapshot to diff against. */
export function fullPatch(data: Record<string, unknown>, unset: string[] = []): ExternalPatch {
	return {
		set: { ...data },
		unset: unset.filter((key) => data[key] === undefined || data[key] === null),
	}
}

/**
 * Apply a patch to a document copy, following dotted paths. Used to keep the
 * values a write committed in the new snapshot even if another client edits the
 * row between the write and the read-back.
 */
export function applyExternalPatch<T extends Record<string, unknown>>(
	doc: T,
	patch: ExternalPatch,
	nested: boolean,
): T {
	const out = structuredCloneSafe(doc)
	const walk = (path: string, create: boolean) => {
		const segments = nested ? path.split('.') : [path]
		let node: Record<string, unknown> = out
		for (const segment of segments.slice(0, -1)) {
			const child = node[segment]
			if (!isPlainObject(child)) {
				if (!create) return null
				node[segment] = {}
			}
			node = node[segment] as Record<string, unknown>
		}
		return { node, key: segments[segments.length - 1] }
	}
	for (const [path, value] of Object.entries(patch.set)) {
		const target = walk(path, true)
		if (target) target.node[target.key] = value
	}
	for (const path of patch.unset) {
		const target = walk(path, false)
		if (!target) continue
		if (nested) delete target.node[target.key]
		else target.node[target.key] = null
	}
	return out
}

/**
 * Copy plain objects and arrays, keep everything else (Dates, ObjectIds,
 * Decimal128) by reference. `structuredClone` would turn BSON classes into plain
 * objects and lose the types this module exists to protect.
 */
function structuredCloneSafe<T>(value: T): T {
	if (Array.isArray(value)) return value.map(structuredCloneSafe) as T
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value)) out[key] = structuredCloneSafe(item)
		return out as T
	}
	return value
}

/**
 * The top-level values a patch writes, with a removed column reading as null.
 * Callers fold the lifecycle timestamps from this back into the cached row.
 */
export function writtenValues(patch: ExternalPatch): Record<string, unknown> {
	const written: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(patch.set)) {
		if (!key.includes('.')) written[key] = value
	}
	for (const key of patch.unset) {
		if (!key.includes('.')) written[key] = null
	}
	return written
}
