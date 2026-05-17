/**
 * Reference-only resolution for imported (external) media-library collections.
 * The import wizard records, per external table, where its files live; on read we
 * turn stored paths/keys into servable URLs without copying anything.
 */

export interface MediaStorageEntry {
	/** 'absolute' | 'r2' | 'cloudflare-images' | 's3' | 'custom-url' */
	adapter: string
	/** Column holding the file path/key. */
	pathColumn: string
	/** Public base URL prepended to relative paths (omitted for the 'absolute' adapter). */
	baseUrl?: string
}

export type MediaStorageMap = Record<string, MediaStorageEntry>

/** Turn a stored path/key into a servable URL using the configured base URL. */
export function resolveMediaPath(value: unknown, entry: MediaStorageEntry): unknown {
	if (typeof value !== 'string' || !value) return value
	if (entry.adapter === 'absolute' || /^https?:\/\//i.test(value)) return value
	if (!entry.baseUrl) return value
	return `${entry.baseUrl.replace(/\/$/, '')}/${value.replace(/^\//, '')}`
}

/** Read the per-table media-storage map from a project's settings. */
export function getMediaStorageMap(project: { settings?: unknown } | undefined): MediaStorageMap {
	const externalDb = (project?.settings as Record<string, unknown> | undefined)?.externalDb as
		| Record<string, unknown>
		| undefined
	const map = externalDb?.mediaStorage
	return map && typeof map === 'object' ? (map as MediaStorageMap) : {}
}

/**
 * Mutate each item's metadata so the path column of an imported media collection
 * resolves to a usable URL. No-op when the collection has no storage entry.
 */
export function applyMediaStorage(
	items: Array<{ metadata?: Record<string, unknown> }>,
	externalTable: string | null | undefined,
	map: MediaStorageMap,
): void {
	if (!externalTable) return
	const entry = map[externalTable]
	if (!entry) return
	for (const item of items) {
		const meta = item.metadata
		if (meta && entry.pathColumn in meta) {
			meta[entry.pathColumn] = resolveMediaPath(meta[entry.pathColumn], entry)
		}
	}
}
