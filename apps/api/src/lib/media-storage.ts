/**
 * Resolution for imported (external) media-library collections.
 * The import wizard records, per external table, where its files live; on read we
 * turn stored paths/keys into servable URLs.
 *
 * Public libraries: prefix relative paths with a configured base URL.
 * Private libraries: generate a short-lived presigned/signed URL using stored credentials.
 */
import type { MediaPathFormat } from './media-path-format.js'
import { cloudflareImageUrl, presignR2, signCloudflareImage } from './media-sign.js'

export interface MediaStorageCredentials {
	// Cloudflare R2
	accountId?: string
	accessKeyId?: string
	secretAccessKey?: string
	bucket?: string
	// Cloudflare Images
	accountHash?: string
	signingKey?: string
	/** API token — required to upload new images (read/signing only needs accountHash + signingKey). */
	apiToken?: string
}

export interface MediaStorageEntry {
	/** 'absolute' | 'r2' | 'cloudflare-images' | 's3' | 'custom-url' */
	adapter: string
	/** Column holding the file path/key. */
	pathColumn: string
	/**
	 * The shape the source system stores in `pathColumn`, detected by sampling on
	 * import and overridable in settings. New rows we write are formatted to match,
	 * because the customer's site reads that column directly and never sees our
	 * read-side normalization.
	 */
	pathFormat?: MediaPathFormat
	/** Variant segment to use when `pathFormat` is `delivery-url-variant`. */
	pathVariant?: string
	/** Public base URL prepended to relative paths (public libraries). */
	baseUrl?: string
	/** Whether the files are publicly fetchable or require signed access. */
	access?: 'public' | 'private'
	/** Credentials for signing private URLs (never sent to the client). */
	credentials?: MediaStorageCredentials
}

export type MediaStorageMap = Record<string, MediaStorageEntry>

/** Read the per-table media-storage map from a project's settings. */
export function getMediaStorageMap(project: { settings?: unknown } | undefined): MediaStorageMap {
	const externalDb = (project?.settings as Record<string, unknown> | undefined)?.externalDb as
		| Record<string, unknown>
		| undefined
	const map = externalDb?.mediaStorage
	return map && typeof map === 'object' ? (map as MediaStorageMap) : {}
}

/** Turn a stored path/key into a servable URL (public prefix or private signed URL). */
export async function resolveMediaValue(
	value: unknown,
	entry: MediaStorageEntry,
): Promise<unknown> {
	if (typeof value !== 'string' || !value) return value

	// Cloudflare Images: the delivery URL needs a variant segment
	// (`/<hash>/<id>/<variant>`) — `/<hash>/<id>` on its own 404s. Sources very
	// often store the bare id or a variant-less URL, so complete it here rather
	// than serving a link the browser can't render. Signing (below) does its own
	// normalization, so this only has to cover the unsigned path.
	if (entry.adapter === 'cloudflare-images') {
		const accountHash = entry.credentials?.accountHash
		const needsVariant =
			!/^https?:\/\//i.test(value) || new URL(value).pathname.split('/').filter(Boolean).length < 3
		if (
			needsVariant &&
			accountHash &&
			!(entry.access === 'private' && entry.credentials?.signingKey)
		) {
			return cloudflareImageUrl(accountHash, value)
		}
	}

	if (entry.access === 'private' && entry.credentials) {
		const c = entry.credentials
		try {
			if (entry.adapter === 'r2' && c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket) {
				return await presignR2(
					{
						accountId: c.accountId,
						accessKeyId: c.accessKeyId,
						secretAccessKey: c.secretAccessKey,
						bucket: c.bucket,
					},
					value,
				)
			}
			if (entry.adapter === 'cloudflare-images' && c.accountHash && c.signingKey) {
				return signCloudflareImage({ accountHash: c.accountHash, signingKey: c.signingKey }, value)
			}
		} catch {
			return value
		}
		return value
	}

	// Public: leave absolute URLs alone, prefix relative paths with the base URL.
	if (entry.adapter === 'absolute' || /^https?:\/\//i.test(value)) return value
	if (!entry.baseUrl) return value
	return `${entry.baseUrl.replace(/\/$/, '')}/${value.replace(/^\//, '')}`
}

/**
 * Mutate each item's metadata so the path column of an imported media collection
 * resolves to a usable URL. No-op when the collection has no storage entry.
 */
export async function applyMediaStorage(
	items: Array<{ metadata?: Record<string, unknown> }>,
	externalTable: string | null | undefined,
	map: MediaStorageMap,
): Promise<void> {
	if (!externalTable) return
	const entry = map[externalTable]
	if (!entry) return
	await Promise.all(
		items.map(async (item) => {
			const meta = item.metadata
			if (meta && entry.pathColumn in meta) {
				meta[entry.pathColumn] = await resolveMediaValue(meta[entry.pathColumn], entry)
			}
		}),
	)
}
