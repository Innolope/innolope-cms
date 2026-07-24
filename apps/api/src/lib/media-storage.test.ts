import { describe, expect, it } from 'vitest'
import { cloudflareImageUrl, parseCloudflareImageValue } from './media-sign.js'
import { type MediaStorageEntry, resolveMediaValue } from './media-storage.js'

const HASH = '8CA2tdaqNe_KDNIRc5st7Q'

const cfEntry = (over: Partial<MediaStorageEntry> = {}): MediaStorageEntry => ({
	adapter: 'cloudflare-images',
	pathColumn: 'fullPath',
	access: 'private',
	credentials: { accountHash: HASH },
	...over,
})

describe('parseCloudflareImageValue', () => {
	it('defaults the variant when the URL has none', () => {
		expect(parseCloudflareImageValue(`https://imagedelivery.net/${HASH}/abc123`)).toEqual({
			imageId: 'abc123',
			variant: 'public',
		})
	})

	it('keeps an explicit variant', () => {
		expect(parseCloudflareImageValue(`https://imagedelivery.net/${HASH}/abc123/thumb`)).toEqual({
			imageId: 'abc123',
			variant: 'thumb',
		})
	})

	it('accepts a bare image id', () => {
		expect(parseCloudflareImageValue('mami.png')).toEqual({
			imageId: 'mami.png',
			variant: 'public',
		})
	})
})

describe('cloudflareImageUrl', () => {
	it('completes a variant-less delivery URL', () => {
		expect(cloudflareImageUrl(HASH, `https://imagedelivery.net/${HASH}/abc123`)).toBe(
			`https://imagedelivery.net/${HASH}/abc123/public`,
		)
	})
})

describe('resolveMediaValue — Cloudflare Images', () => {
	it('adds the missing variant so the URL actually renders', async () => {
		// Regression: Payload stores `/<hash>/<id>` for many assets. Without the
		// variant segment imagedelivery.net 404s, so the media grid was a wall of
		// broken tiles.
		await expect(
			resolveMediaValue(`https://imagedelivery.net/${HASH}/abc123`, cfEntry()),
		).resolves.toBe(`https://imagedelivery.net/${HASH}/abc123/public`)
	})

	it('leaves a complete delivery URL alone', async () => {
		const url = `https://imagedelivery.net/${HASH}/abc123/public`
		await expect(resolveMediaValue(url, cfEntry())).resolves.toBe(url)
	})

	it('expands a bare image id into a delivery URL', async () => {
		await expect(resolveMediaValue('mami.png', cfEntry())).resolves.toBe(
			`https://imagedelivery.net/${HASH}/mami.png/public`,
		)
	})

	it('still signs when a signing key is configured', async () => {
		const signed = (await resolveMediaValue(
			`https://imagedelivery.net/${HASH}/abc123`,
			cfEntry({ credentials: { accountHash: HASH, signingKey: 'deadbeef' } }),
		)) as string
		expect(signed).toContain(`/${HASH}/abc123/public`)
		expect(signed).toContain('sig=')
	})

	it('leaves non-Cloudflare entries untouched', async () => {
		const entry: MediaStorageEntry = {
			adapter: 'absolute',
			pathColumn: 'fullPath',
			access: 'public',
		}
		await expect(resolveMediaValue('https://example.com/a.jpg', entry)).resolves.toBe(
			'https://example.com/a.jpg',
		)
	})
})
