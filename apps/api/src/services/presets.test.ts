import {
	detectFieldPreset,
	detectRichTextFormat,
	looksLikeImageUrl,
	matchPresetValue,
} from '@innolope/config'
import { describe, expect, it } from 'vitest'

describe('matchPresetValue', () => {
	it('recognises an image object and maps its keys', () => {
		expect(
			matchPresetValue({ src: 'https://cdn.example.com/a.jpg', altText: 'A', width: 10 }, 'object'),
		).toEqual({ preset: 'image', keys: { url: 'src', alt: 'altText', width: 'width' } })
	})

	it('does not call a bare { url } an image unless the URL is one', () => {
		expect(matchPresetValue({ url: 'https://example.com/page' }, 'object')).toBeNull()
		expect(matchPresetValue({ url: 'https://example.com/a.png' }, 'object')?.preset).toBe('image')
	})

	it('recognises an image URL string on a text field', () => {
		expect(matchPresetValue('https://images.unsplash.com/photo-1', 'text')?.preset).toBe('image')
		expect(matchPresetValue('just text', 'text')).toBeNull()
	})

	it('recognises links, money, map points, date ranges and addresses', () => {
		expect(matchPresetValue({ title: 'Docs', href: '/docs' }, 'object')).toEqual({
			preset: 'link',
			keys: { label: 'title', url: 'href' },
		})
		expect(matchPresetValue({ amount: 19.99, currency: 'EUR' }, 'object')?.preset).toBe('money')
		expect(matchPresetValue({ amount: 19.99, currency: 'euro' }, 'object')).toBeNull()
		expect(matchPresetValue({ latitude: 50.4, longitude: 30.5 }, 'object')?.preset).toBe(
			'geo-point',
		)
		expect(matchPresetValue({ type: 'Point', coordinates: [30.5, 50.4] }, 'object')?.preset).toBe(
			'geo-point',
		)
		expect(matchPresetValue({ from: '2026-01-01', to: '2026-02-01' }, 'object')?.preset).toBe(
			'date-range',
		)
		expect(
			matchPresetValue({ street: '1 Main St', city: 'Kyiv', zip: '01001' }, 'object')?.preset,
		).toBe('address')
	})

	it('recognises an SEO block with a couple of extra keys', () => {
		expect(
			matchPresetValue(
				{ title: 'T', description: 'D', ogImage: '/og.png', robots: 'index', extra: 1 },
				'object',
			)?.preset,
		).toBe('seo')
	})

	it('recognises rows of social links and a key-value table', () => {
		expect(
			matchPresetValue(
				[
					{ platform: 'linkedin', url: 'https://linkedin.com/in/a' },
					{ platform: 'x', url: 'https://x.com/a' },
				],
				'array',
			)?.preset,
		).toBe('social-link')
		expect(
			matchPresetValue(
				[
					{ key: 'Color', value: 'Red' },
					{ key: 'Size', value: 'M' },
				],
				'array',
			),
		).toEqual({ preset: 'key-value', keys: { key: 'key', value: 'value' } })
	})

	it('leaves arbitrary objects alone', () => {
		expect(matchPresetValue({ a: 1, b: 'x', c: true }, 'object')).toBeNull()
	})
})

describe('detectFieldPreset', () => {
	it('needs agreement across the sample', () => {
		const money = { amount: 1, currency: 'USD' }
		expect(detectFieldPreset([money, { ...money, amount: 2 }], 'object')?.preset).toBe('money')
		expect(detectFieldPreset([money, { a: 1 }], 'object')).toBeNull()
	})

	it('accepts the only value of a near-empty sample', () => {
		expect(detectFieldPreset([{ amount: 1, currency: 'USD' }], 'object')?.preset).toBe('money')
	})

	it('ignores empty values but needs more than one match in a larger sample', () => {
		const money = { amount: 1, currency: 'USD' }
		expect(detectFieldPreset([money, null, null], 'object')).toBeNull()
		expect(detectFieldPreset([money, null, money], 'object')?.preset).toBe('money')
	})
})

describe('detectRichTextFormat', () => {
	it('names each editor-state format by its signature', () => {
		expect(detectRichTextFormat({ root: { type: 'root', children: [] } })).toBe('lexical')
		expect(detectRichTextFormat({ blocks: [{ type: 'paragraph', data: { text: 'x' } }] })).toBe(
			'editorjs',
		)
		expect(detectRichTextFormat([{ _type: 'block', children: [] }])).toBe('portable-text')
		expect(detectRichTextFormat([{ type: 'paragraph', children: [{ text: 'x' }] }])).toBe('slate')
		expect(detectRichTextFormat({ text: 'plain' })).toBeNull()
	})
})

describe('looksLikeImageUrl', () => {
	it('accepts image extensions and known image hosts only', () => {
		expect(looksLikeImageUrl('/uploads/a.webp?w=100')).toBe(true)
		expect(looksLikeImageUrl('https://res.cloudinary.com/x/upload/abc')).toBe(true)
		expect(looksLikeImageUrl('https://example.com/about')).toBe(false)
		expect(looksLikeImageUrl('a.png')).toBe(false)
	})
})
