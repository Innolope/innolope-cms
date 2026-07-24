/**
 * Write path for imported (external) media libraries — the counterpart to the
 * read-only resolution in `media-storage.ts`. Uploads a file into the storage
 * backend a media-library collection was imported from, so new media can be
 * added to that library through the CMS.
 *
 * Only `r2` and `cloudflare-images` are writable. Public / `custom-url`
 * libraries have no writable target.
 */
import { randomUUID } from 'node:crypto'
import { CloudflareImagesAdapter } from '../adapters/cloudflare-images.js'
import { formatMediaPath } from './media-path-format.js'
import { presignR2Put } from './media-sign.js'
import type { MediaStorageEntry } from './media-storage.js'

function httpError(message: string, statusCode: number) {
	return Object.assign(new Error(message), { statusCode })
}

/** True when files can be uploaded into this imported-storage entry. */
export function isWritableImportedStorage(entry: MediaStorageEntry | undefined): boolean {
	return entry?.adapter === 'r2' || entry?.adapter === 'cloudflare-images'
}

export interface ImportedUploadResult {
	/**
	 * The value to store in the collection's path column.
	 *
	 * This has to match what the *source system* already writes there, because the
	 * customer's own site reads that column straight out of their database — it
	 * never goes through this API's read-side resolution. For Cloudflare Images
	 * that means a complete delivery URL, not the bare image id: storing the id
	 * made sites resolve it as a relative path (`https://theirsite/<id>`).
	 * R2 keeps the object key, which is what its presigned reads expect.
	 */
	key: string
}

/** Upload a file into a media library's imported storage; returns the stored key/id. */
export async function uploadToImportedStorage(
	entry: MediaStorageEntry,
	buffer: Buffer,
	filename: string,
	mimeType: string,
): Promise<ImportedUploadResult> {
	const c = entry.credentials || {}

	if (entry.adapter === 'cloudflare-images') {
		if (!c.accountId || !c.apiToken) {
			throw httpError(
				'Cloudflare Images upload needs an Account ID and API token — add them in Imported media storage.',
				400,
			)
		}
		if (!c.accountHash) {
			throw httpError(
				'Cloudflare Images upload needs an Account hash — add it in Imported media storage.',
				400,
			)
		}
		const adapter = new CloudflareImagesAdapter({
			accountId: c.accountId,
			apiToken: c.apiToken,
			accountHash: c.accountHash,
		})
		const result = await adapter.upload(buffer, filename, mimeType)
		// Match whatever shape this library already uses — see `formatMediaPath`.
		return {
			key: formatMediaPath(
				{ id: result.id, url: result.url, accountHash: c.accountHash },
				entry.pathFormat ?? 'delivery-url-variant',
				entry.pathVariant,
			),
		}
	}

	if (entry.adapter === 'r2') {
		if (!c.accountId || !c.accessKeyId || !c.secretAccessKey || !c.bucket) {
			throw httpError(
				'R2 upload needs an account ID, access key ID, secret access key and bucket.',
				400,
			)
		}
		const ext = filename.includes('.') ? filename.split('.').pop() || 'bin' : 'bin'
		const key = `${randomUUID()}.${ext}`
		const url = await presignR2Put(
			{
				accountId: c.accountId,
				accessKeyId: c.accessKeyId,
				secretAccessKey: c.secretAccessKey,
				bucket: c.bucket,
			},
			key,
		)
		const res = await fetch(url, {
			method: 'PUT',
			headers: { 'Content-Type': mimeType },
			body: buffer,
		})
		if (!res.ok) {
			throw httpError(`R2 upload failed: ${res.status} ${res.statusText}`, 502)
		}
		// R2 rows are presigned on read from the object key, so the key is the
		// natural default — but a library that stores rooted paths or absolute CDN
		// URLs gets those instead.
		return {
			key: formatMediaPath(
				{
					key,
					url: entry.baseUrl ? `${entry.baseUrl.replace(/\/$/, '')}/${key}` : undefined,
				},
				entry.pathFormat ?? 'storage-key',
				entry.pathVariant,
			),
		}
	}

	throw httpError(
		`This media library uses ${entry.adapter} storage, which cannot receive uploads.`,
		400,
	)
}
