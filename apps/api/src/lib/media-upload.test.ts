import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaStorageEntry } from './media-storage.js'
import {
	dedupeFilename,
	isDuplicateKeyError,
	isWritableImportedStorage,
	uploadToImportedStorage,
} from './media-upload.js'

const HASH = '8CA2tdaqNe_KDNIRc5st7Q'
const IMAGE_ID = '05cbbcab-316b-4118-cbca-0802385a0700'

const cfEntry = (credentials: Record<string, string>): MediaStorageEntry => ({
	adapter: 'cloudflare-images',
	pathColumn: 'fullPath',
	access: 'private',
	credentials,
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubCloudflareUpload() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({ success: true, result: { id: IMAGE_ID, filename: 'a.jpg' }, errors: [] }),
		),
	)
}

describe('uploadToImportedStorage — Cloudflare Images', () => {
	it('stores a complete delivery URL, not the bare image id', async () => {
		// Regression: the bare id went into the source database, and the customer's
		// site — which reads that column directly — resolved it as a relative path
		// (`https://theirsite/<id>`), so every CMS-uploaded image 404'd there.
		stubCloudflareUpload()
		const result = await uploadToImportedStorage(
			cfEntry({ accountId: 'acc', apiToken: 'tok', accountHash: HASH }),
			Buffer.from('x'),
			'a.jpg',
			'image/jpeg',
		)
		expect(result.key).toBe(`https://imagedelivery.net/${HASH}/${IMAGE_ID}/public`)
	})

	it('refuses to upload without an account hash rather than storing a bare id', async () => {
		stubCloudflareUpload()
		await expect(
			uploadToImportedStorage(
				cfEntry({ accountId: 'acc', apiToken: 'tok' }),
				Buffer.from('x'),
				'a.jpg',
				'image/jpeg',
			),
		).rejects.toThrow(/Account hash/i)
	})

	it('explains what is missing when credentials are incomplete', async () => {
		await expect(
			uploadToImportedStorage(cfEntry({}), Buffer.from('x'), 'a.jpg', 'image/jpeg'),
		).rejects.toThrow(/Account ID and API token/i)
	})
})

describe('isWritableImportedStorage', () => {
	it('accepts the storages we can upload into', () => {
		expect(isWritableImportedStorage(cfEntry({}))).toBe(true)
		expect(
			isWritableImportedStorage({ adapter: 'r2', pathColumn: 'key' } as MediaStorageEntry),
		).toBe(true)
	})

	it('rejects reference-only libraries', () => {
		expect(
			isWritableImportedStorage({ adapter: 'absolute', pathColumn: 'url' } as MediaStorageEntry),
		).toBe(false)
		expect(isWritableImportedStorage(undefined)).toBe(false)
	})
})

describe('isDuplicateKeyError', () => {
	it('recognises unique violations across supported databases', () => {
		// Literal prefix of a production failure: a unique filename index in the
		// customer's library turned a re-upload into a 500.
		expect(
			isDuplicateKeyError(
				new Error(
					'E11000 duplicate key error collection: klekit.blog-media index: filename_1 dup key: { filename: "UCS  2026 award_site_klekit.jpg" }',
				),
			),
		).toBe(true)
		expect(
			isDuplicateKeyError(new Error('duplicate key value violates unique constraint "media_pkey"')),
		).toBe(true)
		expect(isDuplicateKeyError(new Error("Duplicate entry 'a.jpg' for key 'filename'"))).toBe(true)
		expect(isDuplicateKeyError(new Error('connection refused'))).toBe(false)
		expect(isDuplicateKeyError('not an error')).toBe(false)
	})
})

describe('dedupeFilename', () => {
	it('suffixes before the extension and stays unique', () => {
		const a = dedupeFilename('photo.jpg')
		expect(a).toMatch(/^photo-[0-9a-f]{6}\.jpg$/)
		expect(dedupeFilename('photo.jpg')).not.toBe(a)
	})

	it('handles extension-less names', () => {
		expect(dedupeFilename('photo')).toMatch(/^photo-[0-9a-f]{6}$/)
	})
})
