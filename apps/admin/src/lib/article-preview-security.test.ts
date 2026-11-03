import { describe, expect, it } from 'vitest'
import { buildPreviewDocument, fillPreviewSlots, type PreviewTemplateData } from './article-preview'

const TEMPLATE: PreviewTemplateData = {
	html: '<html><head><title>Original</title><style>body{color:navy}</style></head><body><main data-innolope-slot="body"><header id="heading"><div><h1 data-innolope-slot="title">Original</h1></div></header><figure id="hero"><picture><source srcset="https://example.com/old.webp"><img data-innolope-slot="image" src="https://example.com/old.jpg"></picture></figure>Obsolete loose text<!-- obsolete comment --><p id="obsolete">Obsolete paragraph</p><section id="obsolete-section"><p>Obsolete section</p></section></main></body></html>',
	classMap: { p: 'article-paragraph', code: 'inline-code' },
}
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

describe('preview supplemental nested-slot contract: A10', () => {
	it.each([
		'referrer',
		'REFERRER',
	])('puts CSP first and replaces %s with one no-referrer policy before resources', (name) => {
		const template = {
			...TEMPLATE,
			html: TEMPLATE.html.replace('<head>', `<head><meta name="${name}" content="unsafe-url">`),
		}
		const doc = parse(buildPreviewDocument(template, { title: 'Draft', markdown: '' }))
		expect(doc.head.firstChild).toBe(
			doc.querySelector('meta[http-equiv="Content-Security-Policy"]'),
		)
		expect(doc.querySelectorAll('meta[name="referrer"]')).toHaveLength(1)
		expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
		expect(doc.head.children[1]).toBe(doc.querySelector('meta[name="referrer"]'))
	})
	it('preserves missing doctype and removes every ordinary body child on initial fill', () => {
		const output = buildPreviewDocument(TEMPLATE, {
			title: 'New title',
			markdown: 'New paragraph.',
		})
		expect(output).not.toMatch(/<!doctype/i)
		const doc = parse(output)
		expect(doc.querySelector('#heading h1')?.textContent).toBe('New title')
		expect(doc.querySelector('#hero [data-innolope-slot="image"]')).not.toBeNull()
		expect(doc.querySelector('#obsolete, #obsolete-section')).toBeNull()
		expect(doc.body.innerHTML).not.toContain('Obsolete')
		expect(doc.body.innerHTML).not.toContain('obsolete comment')
		expect(doc.querySelector('main > p')?.textContent).toBe('New paragraph.')
	})

	it('retains nested slot nodes across repeated edits, sanitizes each body, and restores an absent image', () => {
		const doc = parse(
			buildPreviewDocument(TEMPLATE, {
				title: 'First',
				markdown: 'First paragraph.',
				imageUrl: 'https://example.com/first.jpg',
			}),
		)
		const heading = doc.querySelector('#heading')
		const image = doc.querySelector('[data-innolope-slot="image"]')
		const style = doc.querySelector('style')
		fillPreviewSlots(doc, TEMPLATE.classMap, {
			title: 'Second',
			markdown: 'Second paragraph.\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>',
			imageUrl: null,
		})
		expect(doc.querySelector('#heading')).toBe(heading)
		expect(doc.querySelector('[data-innolope-slot="image"]')).toBe(image)
		expect(image?.hasAttribute('hidden') || image?.closest('[hidden]') !== null).toBe(true)
		expect(doc.body.innerHTML).not.toContain('first.jpg')
		expect(doc.body.textContent).not.toContain('First paragraph.')
		expect(doc.querySelector('script, [onerror]')).toBeNull()
		fillPreviewSlots(doc, TEMPLATE.classMap, {
			title: 'Third',
			markdown: 'Final `inline`.\n\n```js\nconst final = true\n```',
			imageUrl: 'https://example.com/final.jpg',
			imageAlt: 'Final cover',
		})
		expect(doc.querySelector('#heading')).toBe(heading)
		expect(heading?.textContent).toBe('Third')
		expect(doc.querySelector('[data-innolope-slot="image"]')).toBe(image)
		expect(image?.getAttribute('src')).toBe('https://example.com/final.jpg')
		expect(image?.getAttribute('alt')).toBe('Final cover')
		expect(image?.closest('[hidden]')).toBeNull()
		expect(doc.querySelector('picture source')).toBeNull()
		expect(doc.body.textContent).not.toContain('Second paragraph.')
		expect(doc.querySelectorAll('main > p')).toHaveLength(1)
		expect(doc.querySelector('p code')?.className).toBe('inline-code')
		expect(doc.querySelector('pre code')?.classList.contains('inline-code')).toBe(false)
		expect(doc.querySelector('style')).toBe(style)
	})
})
