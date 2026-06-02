export interface DetectedTable {
	name: string
	columns: { name: string; type: string; relationTo?: string; relationIsArray?: boolean }[]
	count?: number
	sizeBytes?: number
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${Math.round(bytes / 1024 / 1024)} MB`
}

/** Unique collection names this table references that also exist in the scanned set. */
export function relationTargets(table: DetectedTable, allTables: DetectedTable[]): string[] {
	const known = new Set(allTables.map((t) => t.name))
	const targets = new Set<string>()
	for (const col of table.columns) {
		if (col.relationTo && known.has(col.relationTo) && col.relationTo !== table.name) {
			targets.add(col.relationTo)
		}
	}
	return [...targets]
}

// ─── Media-library detection ──────────────────────────────────────────────
const MEDIA_NAME_RE = /^(media|images?|files?|assets?|uploads?|photos?|gallery|attachments?)s?$/i
const FILE_REF_RE = /(^|_)(url|src|path|image|photo|file|thumbnail)($|_)/i
const FILE_META_RE = /(^|_)(mime|mimetype|filename|filesize|size|width|height|alt)($|_)/i

/** Split camelCase so `imageUrl` matches the `_`-delimited column patterns. */
export const splitCamelCol = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')

/** Heuristic: does this imported table look like a media library? */
export function isMediaTable(table: DetectedTable): boolean {
	if (MEDIA_NAME_RE.test(table.name)) return true
	const hasRef = table.columns.some((c) => FILE_REF_RE.test(splitCamelCol(c.name)))
	const hasMeta = table.columns.some((c) => FILE_META_RE.test(splitCamelCol(c.name)))
	return hasRef && hasMeta
}

/** Best guess for the column holding the file path/key. */
export function pickPathColumn(table: DetectedTable): string {
	const ref = table.columns.find((c) => FILE_REF_RE.test(splitCamelCol(c.name)))
	return ref?.name || table.columns[0]?.name || ''
}

/** Heuristic applied to an already-imported collection (operates on its `fields`). */
export function isMediaCollectionLike(col: { name: string; fields: { name: string }[] }): boolean {
	if (MEDIA_NAME_RE.test(col.name)) return true
	const hasRef = col.fields.some((f) => FILE_REF_RE.test(splitCamelCol(f.name)))
	const hasMeta = col.fields.some((f) => FILE_META_RE.test(splitCamelCol(f.name)))
	return hasRef && hasMeta
}

/** Best guess for the file-path field of an imported collection. */
export function pickPathField(fields: { name: string }[]): string {
	return fields.find((f) => FILE_REF_RE.test(splitCamelCol(f.name)))?.name || fields[0]?.name || ''
}
