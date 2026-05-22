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
	/** The value to store in the collection's path column. */
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
		const adapter = new CloudflareImagesAdapter({
			accountId: c.accountId,
			apiToken: c.apiToken,
			accountHash: c.accountHash || '',
		})
		const result = await adapter.upload(buffer, filename, mimeType)
		return { key: result.id }
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
		return { key }
	}

	throw httpError(
		`This media library uses ${entry.adapter} storage, which cannot receive uploads.`,
		400,
	)
}
