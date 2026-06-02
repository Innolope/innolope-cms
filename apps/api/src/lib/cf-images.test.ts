import { describe, expect, it } from 'vitest'
import { cfImageUrl, cfImageVariants, isCfImagesUrl } from './cf-images.js'

const CF = 'https://imagedelivery.net/abc123/img-456/public'

describe('isCfImagesUrl', () => {
	it('matches Cloudflare Images delivery URLs', () => {
		expect(isCfImagesUrl(CF)).toBe(true)
		expect(isCfImagesUrl(`${CF}/`)).toBe(true)
	})

	it('rejects unrelated URLs', () => {
		expect(isCfImagesUrl('https://example.com/img.png')).toBe(false)
		expect(isCfImagesUrl('https://imagedelivery.net/abc123/img-456/public/extra')).toBe(false)
	})
})

describe('cfImageUrl', () => {
	it('swaps the variant segment for a transform', () => {
		expect(cfImageUrl(CF, 'w=160,format=auto')).toBe(
			'https://imagedelivery.net/abc123/img-456/w=160,format=auto',
		)
	})

	it('returns the input unchanged for non-CF URLs', () => {
		const other = 'https://example.com/x.png'
		expect(cfImageUrl(other, 'w=160')).toBe(other)
	})
})

describe('cfImageVariants', () => {
	it('returns responsive renditions for CF URLs', () => {
		const v = cfImageVariants(CF)
		expect(v).toBeDefined()
		expect(Object.keys(v ?? {})).toEqual(['thumbnail', 'small', 'medium', 'large'])
		expect(v?.thumbnail).toContain('w=160')
	})

	it('returns undefined for non-CF URLs', () => {
		expect(cfImageVariants('https://example.com/x.png')).toBeUndefined()
	})
})
