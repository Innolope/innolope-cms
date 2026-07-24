import { describe, expect, it } from 'vitest'
import { classifyMediaPath, detectMediaPathFormat, formatMediaPath } from './media-path-format.js'

const HASH = '8CA2tdaqNe_KDNIRc5st7Q'
const ID = '05cbbcab-316b-4118-cbca-0802385a0700'

describe('classifyMediaPath', () => {
	it('recognises a complete Cloudflare delivery URL and its variant', () => {
		expect(classifyMediaPath(`https://imagedelivery.net/${HASH}/${ID}/public`)).toEqual({
			format: 'delivery-url-variant',
			variant: 'public',
		})
	})

	it('keeps a non-default variant', () => {
		expect(
			classifyMediaPath(`https://imagedelivery.net/${HASH}/${ID}/format=auto,width=400`),
		).toEqual({ format: 'delivery-url-variant', variant: 'format=auto,width=400' })
	})

	it('recognises a variant-less delivery URL', () => {
		expect(classifyMediaPath(`https://imagedelivery.net/${HASH}/${ID}`)).toEqual({
			format: 'delivery-url',
		})
	})

	it('treats other hosts as plain absolute URLs', () => {
		expect(classifyMediaPath('https://cdn.example.com/a.jpg')).toEqual({ format: 'absolute-url' })
	})

	it('separates root-relative paths from bucket keys', () => {
		expect(classifyMediaPath('/uploads/a.jpg')).toEqual({ format: 'root-path' })
		expect(classifyMediaPath('2024/covers/a.jpg')).toEqual({ format: 'storage-key' })
	})

	it('calls a bare uuid an image id but a bare filename a key', () => {
		expect(classifyMediaPath(ID)).toEqual({ format: 'image-id' })
		expect(classifyMediaPath('mami.png')).toEqual({ format: 'storage-key' })
	})
})

describe('detectMediaPathFormat', () => {
	it('returns null when there is nothing to sample', () => {
		expect(detectMediaPathFormat([])).toBeNull()
		expect(detectMediaPathFormat(['', '   '])).toBeNull()
	})

	it('picks the dominant shape and reports its working', () => {
		const detected = detectMediaPathFormat([
			`https://imagedelivery.net/${HASH}/a/public`,
			`https://imagedelivery.net/${HASH}/b/public`,
			`https://imagedelivery.net/${HASH}/c/public`,
			`https://imagedelivery.net/${HASH}/d`,
		])
		expect(detected).toMatchObject({
			format: 'delivery-url-variant',
			variant: 'public',
			matched: 3,
			sampled: 4,
		})
		expect(detected?.breakdown).toEqual([
			{ format: 'delivery-url-variant', count: 3, variant: 'public' },
			{ format: 'delivery-url', count: 1, variant: undefined },
		])
	})

	it('does not let a one-off variant outvote the common one', () => {
		const detected = detectMediaPathFormat([
			`https://imagedelivery.net/${HASH}/a/public`,
			`https://imagedelivery.net/${HASH}/b/public`,
			`https://imagedelivery.net/${HASH}/c/thumbnail`,
		])
		expect(detected?.variant).toBe('public')
	})

	it('learns the account variant even when another format wins', () => {
		const detected = detectMediaPathFormat([
			'aaaaaaaa-1111-2222-3333-444444444444',
			'bbbbbbbb-1111-2222-3333-444444444444',
			'cccccccc-1111-2222-3333-444444444444',
			`https://imagedelivery.net/${HASH}/d/hero`,
		])
		expect(detected?.format).toBe('image-id')
		expect(detected?.suggestedVariant).toBe('hero')
	})

	it('suggests no variant when the sample has no complete delivery URLs', () => {
		const detected = detectMediaPathFormat(['/uploads/a.jpg', '/uploads/b.jpg'])
		expect(detected?.suggestedVariant).toBeUndefined()
	})
})

describe('formatMediaPath', () => {
	const ref = { id: ID, url: `https://imagedelivery.net/${HASH}/${ID}/public`, accountHash: HASH }

	it('reproduces each recorded shape', () => {
		expect(formatMediaPath(ref, 'delivery-url-variant', 'public')).toBe(
			`https://imagedelivery.net/${HASH}/${ID}/public`,
		)
		expect(formatMediaPath(ref, 'delivery-url-variant', 'thumb')).toBe(
			`https://imagedelivery.net/${HASH}/${ID}/thumb`,
		)
		expect(formatMediaPath(ref, 'delivery-url')).toBe(`https://imagedelivery.net/${HASH}/${ID}`)
		expect(formatMediaPath(ref, 'image-id')).toBe(ID)
	})

	it('renders bucket shapes from the object key', () => {
		const r2 = { key: '2024/a.jpg' }
		expect(formatMediaPath(r2, 'storage-key')).toBe('2024/a.jpg')
		expect(formatMediaPath(r2, 'root-path')).toBe('/2024/a.jpg')
	})

	it('falls back to the most complete value when the format cannot be produced', () => {
		// An R2 upload into a library recorded as Cloudflare-delivery: there is no
		// image id, so a resolvable URL beats an unusable one.
		expect(formatMediaPath({ url: 'https://cdn.example.com/a.jpg' }, 'delivery-url-variant')).toBe(
			'https://cdn.example.com/a.jpg',
		)
	})

	it('defaults to the complete URL for a library with no recorded format', () => {
		expect(formatMediaPath(ref, undefined)).toBe(`https://imagedelivery.net/${HASH}/${ID}/public`)
	})
})
