import { describe, expect, it } from 'vitest'
import {
	conformsToSiteConvention,
	customerVisibleUrl,
	lintMediaValue,
	summarizeMediaHealth,
} from './media-health.js'
import type { MediaStorageEntry } from './media-storage.js'

const HASH = '8CA2tdaqNe_KDNIRc5st7Q'

const cfEntry = (over: Partial<MediaStorageEntry> = {}): MediaStorageEntry => ({
	adapter: 'cloudflare-images',
	pathColumn: 'fullPath',
	pathFormat: 'delivery-url-variant',
	access: 'public',
	credentials: { accountHash: HASH },
	...over,
})

describe('lintMediaValue', () => {
	it('flags the glued base-URL/rooted-path row as broken beyond repair', () => {
		// Literal shape found in a production library: an /uploads/… path was
		// prefixed with the delivery base URL, producing an id Cloudflare never
		// issued. Only a re-upload can fix it.
		const lint = lintMediaValue(
			`https://imagedelivery.net/${HASH}//uploads/c5f6e8c6-785c-4d54-89df-38607f7033de.jpg/public`,
			cfEntry(),
		)
		expect(lint.problems).toContain('empty-path-segment')
		expect(lint.repairable).toBe(false)
		expect(lint.suggestedFix).toBeUndefined()
	})

	it('repairs a variant-less delivery URL with the library variant', () => {
		const lint = lintMediaValue(`https://imagedelivery.net/${HASH}/abc123`, cfEntry())
		expect(lint.problems).toContain('missing-variant')
		expect(lint.suggestedFix).toBe(`https://imagedelivery.net/${HASH}/abc123/public`)
		expect(lint.repairable).toBe(true)
	})

	it('uses the configured variant, not a hardcoded public', () => {
		const lint = lintMediaValue(
			`https://imagedelivery.net/${HASH}/abc123`,
			cfEntry({ pathVariant: 'hero' }),
		)
		expect(lint.suggestedFix).toBe(`https://imagedelivery.net/${HASH}/abc123/hero`)
	})

	it('repairs a bare id stored in a complete-URL library', () => {
		// The Klekit incident: a bare image id in a fullPath column made the
		// customer site resolve it as https://theirsite/<id>.
		const lint = lintMediaValue('05cbbcab-316b-4118-cbca-0802385a0700', cfEntry())
		expect(lint.problems).toContain('shape-mismatch:image-id')
		expect(lint.suggestedFix).toBe(
			`https://imagedelivery.net/${HASH}/05cbbcab-316b-4118-cbca-0802385a0700/public`,
		)
	})

	it('accepts a well-formed value with no findings', () => {
		const lint = lintMediaValue(`https://imagedelivery.net/${HASH}/abc123/public`, cfEntry())
		expect(lint.problems).toEqual([])
		expect(lint.suggestedFix).toBeUndefined()
		expect(lint.repairable).toBe(true)
	})

	it('flags a shape mismatch without inventing a fix it cannot derive', () => {
		const lint = lintMediaValue('/uploads/a.jpg', cfEntry())
		expect(lint.problems).toContain('shape-mismatch:root-path')
		expect(lint.suggestedFix).toBeUndefined()
	})

	it('does not call a variant-less URL broken in a variant-less library', () => {
		// A library whose convention IS the variant-less delivery URL (the site
		// appends its own transform segment) must not get missing-variant findings
		// or /public rewrites — that convention is the healthy state.
		const lint = lintMediaValue(
			`https://imagedelivery.net/${HASH}/abc123`,
			cfEntry({ pathFormat: 'delivery-url' }),
		)
		expect(lint.problems).toEqual([])
		expect(lint.suggestedFix).toBeUndefined()
	})
})

describe('conformsToSiteConvention', () => {
	it('accepts a value matching a site-completed format', () => {
		expect(
			conformsToSiteConvention(
				`https://imagedelivery.net/${HASH}/abc123`,
				cfEntry({ pathFormat: 'delivery-url' }),
			),
		).toBe(true)
		expect(
			conformsToSiteConvention(
				'05cbbcab-316b-4118-cbca-0802385a0700',
				cfEntry({ pathFormat: 'image-id' }),
			),
		).toBe(true)
	})

	it('rejects deviating values so they still get probed', () => {
		// The glued base-URL row is NOT the convention even in a delivery-url library.
		expect(
			conformsToSiteConvention(
				`https://imagedelivery.net/${HASH}//uploads/a.jpg/public`,
				cfEntry({ pathFormat: 'delivery-url' }),
			),
		).toBe(false)
		expect(
			conformsToSiteConvention('/uploads/a.jpg', cfEntry({ pathFormat: 'delivery-url' })),
		).toBe(false)
	})

	it('never short-circuits directly-fetchable formats', () => {
		// Complete URLs are probeable as-is; conformance is no excuse to skip them.
		expect(
			conformsToSiteConvention(`https://imagedelivery.net/${HASH}/abc123/public`, cfEntry()),
		).toBe(false)
	})

	it('never applies without a recorded format', () => {
		expect(
			conformsToSiteConvention(
				`https://imagedelivery.net/${HASH}/abc123`,
				cfEntry({ pathFormat: undefined }),
			),
		).toBe(false)
	})
})

describe('customerVisibleUrl', () => {
	it('returns absolute values verbatim', () => {
		expect(customerVisibleUrl('https://cdn.example.com/a.jpg', cfEntry())).toBe(
			'https://cdn.example.com/a.jpg',
		)
	})

	it('prefixes relative values with the public base URL', () => {
		const entry = cfEntry({ adapter: 'custom-url', baseUrl: 'https://cdn.example.com/' })
		expect(customerVisibleUrl('/uploads/a.jpg', entry)).toBe(
			'https://cdn.example.com/uploads/a.jpg',
		)
	})

	it('cannot know the URL for private storage or missing base URL', () => {
		expect(customerVisibleUrl('a.jpg', cfEntry())).toBeNull()
		expect(
			customerVisibleUrl('a.jpg', cfEntry({ access: 'private', baseUrl: 'https://cdn.x.com' })),
		).toBeNull()
	})
})

describe('summarizeMediaHealth', () => {
	it('counts verdicts', () => {
		const summary = summarizeMediaHealth([
			{ externalId: '1', rawValue: 'a', verdict: 'ok', problems: [], repairable: true },
			{ externalId: '2', rawValue: 'b', verdict: 'broken', problems: [], repairable: false },
			{ externalId: '3', rawValue: 'c', verdict: 'masked', problems: [], repairable: true },
			{ externalId: '4', rawValue: '', verdict: 'skipped', problems: [], repairable: false },
		])
		expect(summary).toEqual({ total: 4, ok: 1, broken: 1, masked: 1, skipped: 1 })
	})
})
