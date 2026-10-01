import { BODY_FIELD_NAMES } from './localized-fields.js'

/** The last external state is separate from CMS authorship and version history. */
export interface SyncState {
	status: string
	markdown: string
	metadata: Record<string, unknown>
}

export function syncState(row: {
	status?: unknown
	markdown?: unknown
	metadata?: unknown
}): SyncState {
	return {
		status: String(row.status ?? ''),
		markdown: String(row.markdown ?? ''),
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
	}
}

/** Stable at every depth; JSON's replacer-array silently drops nested keys. */
export function stableValue(value: unknown): string {
	if (value instanceof Date) return JSON.stringify(value.toISOString())
	// BSON ObjectIds (including relation ids) serialize as strings in JSONB.
	if (
		value &&
		typeof value === 'object' &&
		'toJSON' in value &&
		typeof value.toJSON === 'function'
	) {
		const json = value.toJSON()
		if (json !== value) return stableValue(json)
	}
	if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'undefined'
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

/** Preserve local-only changes and merge unrelated changes, including locale maps. */
export function mergeSyncState(
	baseline: SyncState | null | undefined,
	local: SyncState,
	incoming: SyncState,
	choice?: 'local' | 'external',
): { state: SyncState; conflicts: string[] } {
	const conflicts: string[] = []
	// Old imports have no baseline. With no recorded CMS edit, they are a cache
	// refresh. The caller handles attributed legacy edits conservatively.
	const base = baseline ?? local
	// Localized body maps own the content; markdown is only their generated
	// search/preview copy. Compare translations, not two copies of the same edit.
	const bodyField = BODY_FIELD_NAMES.find((name) =>
		[base, local, incoming].some((state) => {
			const value = state.metadata[name]
			return (
				isObject(value) &&
				Object.keys(value).length > 0 &&
				Object.entries(value).every(
					([key, text]) =>
						/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(key) && (text == null || typeof text === 'string'),
				)
			)
		}),
	)
	const merge = (before: unknown, ours: unknown, theirs: unknown, path: string): unknown => {
		if (stableValue(ours) === stableValue(theirs)) return theirs
		if (stableValue(ours) === stableValue(before)) return theirs
		if (stableValue(theirs) === stableValue(before)) return ours
		if (isObject(before) && isObject(ours) && isObject(theirs)) {
			const result: Record<string, unknown> = {}
			for (const key of new Set([
				...Object.keys(before),
				...Object.keys(ours),
				...Object.keys(theirs),
			])) {
				const value = merge(before[key], ours[key], theirs[key], path ? `${path}.${key}` : key)
				if (value !== undefined) result[key] = value
			}
			return result
		}
		conflicts.push(path)
		return choice === 'external' ? theirs : ours
	}
	const withoutPreview = (state: SyncState) => (bodyField ? { ...state, markdown: '' } : state)
	const state = merge(
		withoutPreview(base),
		withoutPreview(local),
		withoutPreview(incoming),
		'',
	) as SyncState
	if (bodyField) {
		const body = state.metadata[bodyField]
		state.markdown = isObject(body)
			? (Object.values(body)
					.filter((text): text is string => typeof text === 'string')
					.sort((a, b) => b.length - a.length)[0] ?? '')
			: String(body ?? '')
	}
	return { state, conflicts }
}
