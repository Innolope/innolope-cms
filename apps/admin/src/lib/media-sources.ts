/**
 * One view over every place this project keeps media.
 *
 * There are two distinct stores and they are not interchangeable:
 *
 *   - the **project library** (`/api/v1/media`), whose files live in whatever
 *     `settings.mediaAdapter` points at (local disk, R2, Cloudflare Images);
 *   - any number of **imported libraries** — collections synced from the
 *     customer's own database, whose files live in *that* project's storage and
 *     whose rows are the ones a `relation` field actually references.
 *
 * Uploading into the wrong one is the bug this module exists to prevent: a file
 * put in the project library but registered against an imported collection ends
 * up as a path the source database (and the site reading it) cannot resolve.
 * Always upload through `uploadToSource`.
 */
import { api } from './api-client'
import type { CollectionWithCount } from './collections'

/** A media item normalized across both stores. */
export interface MediaAsset {
	/** Value a relation field should store — the external id when there is one. */
	id: string
	/** Servable URL. Imported libraries are already resolved server-side. */
	url: string
	filename: string
	alt: string | null
	mimeType?: string
	size?: number
	createdAt?: string
	/** Cloudflare Images renditions, project-library items only. */
	variants?: { thumbnail: string; small: string; medium: string; large: string }
}

export interface MediaSource {
	/** `library` for the project library, otherwise the collection id. */
	id: string
	label: string
	/** Set for imported libraries; drives which endpoints are used. */
	collection?: CollectionWithCount
}

export const PROJECT_LIBRARY_ID = 'library'

/**
 * Whether new files can be added to this source. The project library always
 * accepts uploads; an imported library only does when its storage is writable
 * (R2 / Cloudflare Images) — public-URL libraries are reference-only.
 */
export function canUploadTo(source: MediaSource | undefined): boolean {
	if (!source) return false
	return source.collection ? source.collection.mediaWritable === true : true
}

/**
 * Every media source available to the project: the built-in library first, then
 * each imported collection that the import wizard recorded a file column for
 * (`mediaPathColumn`) — that flag is what makes a collection a media library
 * rather than ordinary content.
 */
export function listMediaSources(
	collections: CollectionWithCount[],
	libraryLabel: string,
): MediaSource[] {
	const imported = collections
		.filter((c) => !!c.mediaPathColumn)
		.map((c) => ({ id: c.id, label: c.label, collection: c }))
	return [{ id: PROJECT_LIBRARY_ID, label: libraryLabel }, ...imported]
}

interface RawMediaRow {
	id: string
	type?: string
	filename?: string
	mimeType?: string
	size?: number
	url?: string
	alt?: string | null
	createdAt?: string
	variants?: MediaAsset['variants']
}

interface RawContentRow {
	id: string
	externalId?: string
	metadata?: Record<string, unknown>
	createdAt?: string
}

/** Resolve a possibly-localized ({ en, ua, … }) value to a plain string. */
function plainText(raw: unknown): string {
	if (typeof raw === 'string') return raw
	if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
	if (raw && typeof raw === 'object') {
		const first = Object.values(raw as Record<string, unknown>).find((v) => typeof v === 'string')
		return typeof first === 'string' ? first : ''
	}
	return ''
}

/** Best-effort display name for an imported row that has no filename column. */
function filenameFromUrl(url: string): string {
	const withoutQuery = url.split('?')[0]
	const last = withoutQuery.split('/').filter(Boolean).pop()
	return last ? decodeURIComponent(last) : url
}

/** Load a page of assets from whichever store the source points at. */
export async function fetchMediaAssets(
	source: MediaSource,
	opts: { limit?: number; type?: string } = {},
): Promise<MediaAsset[]> {
	const limit = opts.limit ?? 50

	if (!source.collection) {
		const params = new URLSearchParams({ limit: String(limit) })
		if (opts.type) params.set('type', opts.type)
		const res = await api.get<{ data: RawMediaRow[] }>(`/api/v1/media?${params}`)
		return (res.data ?? []).map((row) => ({
			id: row.id,
			url: row.url ?? '',
			filename: row.filename ?? '',
			alt: row.alt ?? null,
			mimeType: row.mimeType,
			size: row.size,
			createdAt: row.createdAt,
			variants: row.variants,
		}))
	}

	const pathColumn = source.collection.mediaPathColumn
	if (!pathColumn) return []
	const res = await api.get<{ data: RawContentRow[] }>(
		`/api/v1/content?collectionId=${source.collection.id}&limit=${limit}`,
	)
	const fields = source.collection.fields ?? []
	const pick = (names: RegExp) => fields.find((f) => names.test(f.name))?.name
	const altField = pick(/^(alt|altText|alt_text|caption|title)$/i)
	const nameField = pick(/^(filename|fileName|name|file_name)$/i)
	const mimeField = pick(/^(mimeType|mime_type|mime|contentType)$/i)
	const sizeField = pick(/^(filesize|fileSize|size|bytes)$/i)

	return (res.data ?? [])
		.map((row) => {
			const meta = row.metadata ?? {}
			// The server already turned the stored key into a servable URL
			// (`applyMediaStorage`), so this is display-ready.
			const url = plainText(meta[pathColumn])
			return {
				// Relation fields reference the external id — match `docId()` in RelationField.
				id: row.externalId || row.id,
				url,
				filename: (nameField && plainText(meta[nameField])) || filenameFromUrl(url),
				alt: altField ? plainText(meta[altField]) || null : null,
				mimeType: mimeField ? plainText(meta[mimeField]) || undefined : undefined,
				size:
					sizeField && typeof meta[sizeField] === 'number'
						? (meta[sizeField] as number)
						: undefined,
				createdAt: row.createdAt,
			}
		})
		.filter((a) => a.url !== '')
}

/**
 * Upload into the store the source actually owns. Imported libraries go through
 * the project's imported-storage endpoint so the file lands in their own bucket
 * and the external row records the real key.
 */
export async function uploadToSource(
	source: MediaSource,
	file: File,
	projectId: string,
): Promise<void> {
	const form = new FormData()
	form.append('file', file)
	if (source.collection) {
		await api.upload(
			`/api/v1/projects/${projectId}/database/media-upload?collectionId=${source.collection.id}`,
			form,
		)
		return
	}
	await api.upload('/api/v1/media/upload', form)
}
