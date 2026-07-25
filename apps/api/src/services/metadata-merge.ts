/**
 * Merge semantics for metadata on updates (PUT /content/:id and PUT /content/bulk).
 *
 * A partial update must never wipe fields the caller didn't send: the MCP tools
 * and the SDK both document metadata updates as "merged with the current
 * values", and the external-sync path already built its outgoing document from
 * the merged view — while the CMS cache stored the partial one, so a
 * metadata-only update read back with half its fields missing even though the
 * external database still had them. One merge, used for validation, the
 * external write, and the cached row alike, is the fix for both.
 *
 * Deletion stays possible: an explicit `null` removes the key. (Storing null
 * and deleting the key are indistinguishable to every reader — validators
 * treat both as empty, JSONB `->>` yields NULL for both — so null is free to
 * carry the "remove this" intent.)
 */
export function mergeMetadataUpdate(
	current: Record<string, unknown> | null | undefined,
	incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (incoming === undefined) return undefined
	const merged: Record<string, unknown> = { ...(current ?? {}) }
	for (const [key, value] of Object.entries(incoming)) {
		if (value === null) delete merged[key]
		else merged[key] = value
	}
	return merged
}
