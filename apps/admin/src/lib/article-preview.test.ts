import { describe, expect, it } from 'vitest'
import { buildPreviewDocument, fillPreviewSlots, type PreviewTemplateData } from './article-preview'

const TEMPLATE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><base href="https://blog.example.com/posts/sample"><title>Sample post – Example Blog</title><style data-innolope-href="https://blog.example.com/css/main.css">body{font-family:Georgia}</style></head><body><header><a href="https://blog.example.com/">Example</a></header><article><h1 class="post-title" data-innolope-slot="title">Sample post</h1><figure class="hero"><picture><source srcset="https://blog.example.com/img/sample.webp" type="image/webp"><img data-innolope-slot="image" src="https://blog.example.com/img/sample.jpg" srcset="https://blog.example.com/img/sample.jpg 1x, https://blog.example.com/img/sample@2x.jpg 2x" sizes="100vw" alt="Sample"></picture></figure><div class="post-body" data-innolope-slot="body"></div></article><footer>© Example</footer></body></html>`

const TEMPLATE: PreviewTemplateData = {
	html: TEMPLATE_HTML,
	classMap: {
		p: 'mb-6 text-lg',
		h2: 'mt-10 text-2xl',
		ul: 'list-disc pl-6',
		li: 'mb-2',
		a: 'text-blue-600 underline',
		code: 'rounded bg-gray-100',
	},
}

function parse(html: string): Document {
	return new DOMParser().parseFromString(html, 'text/html')
}

function slot(doc: Document, name: string): Element | null {
	return doc.querySelector(`[data-innolope-slot="${name}"]`)
}

describe('buildPreviewDocument', () => {
	it('fills the title, body and document title with the record content', () => {
		const out = buildPreviewDocument(TEMPLATE, {
			title: 'Our new release',
			markdown: 'First paragraph.\n\nSecond paragraph.',
			locale: 'de',
		})
		expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
		const doc = parse(out)
		expect(slot(doc, 'title')?.textContent).toBe('Our new release')
		expect(doc.title).toBe('Our new release')
		expect(doc.documentElement.getAttribute('lang')).toBe('de')
		const paras = slot(doc, 'body')?.querySelectorAll('p') ?? []
		expect(Array.from(paras).map((p) => p.textContent)).toEqual([
			'First paragraph.',
			'Second paragraph.',
		])
		// The chrome of the captured page is untouched.
		expect(doc.querySelector('header a')?.textContent).toBe('Example')
		expect(doc.querySelector('footer')?.textContent).toBe('© Example')
		expect(doc.querySelector('style[data-innolope-href]')?.textContent).toContain('Georgia')
	})

	it("applies the site's harvested classes to the rendered markdown", () => {
		const doc = parse(
			buildPreviewDocument(TEMPLATE, {
				title: 'T',
				markdown:
					'Intro with [a link](https://example.com) and `inline`.\n\n## Section\n\n- one\n- two\n\n```\nblock code\n```',
			}),
		)
		const body = slot(doc, 'body') as Element
		expect(body.querySelector('p')?.className).toBe('mb-6 text-lg')
		expect(body.querySelector('h2')?.className).toBe('mt-10 text-2xl')
		expect(body.querySelector('ul')?.className).toBe('list-disc pl-6')
		expect(body.querySelector('li')?.className).toBe('mb-2')
		expect(body.querySelector('a')?.className).toBe('text-blue-600 underline')
		expect(body.querySelector('p code')?.className).toBe('rounded bg-gray-100')
		// Inline-code classes never leak onto fenced blocks.
		expect(body.querySelector('pre code')?.className ?? '').not.toContain('rounded bg-gray-100')
	})

	it('swaps in the record image and drops responsive sources that would override it', () => {
		const doc = parse(
			buildPreviewDocument(TEMPLATE, {
				title: 'T',
				markdown: 'x',
				imageUrl: 'https://cdn.example.com/cover.png',
				imageAlt: 'Cover',
			}),
		)
		const img = slot(doc, 'image') as HTMLImageElement
		expect(img.getAttribute('src')).toBe('https://cdn.example.com/cover.png')
		expect(img.getAttribute('alt')).toBe('Cover')
		expect(img.hasAttribute('srcset')).toBe(false)
		expect(img.hasAttribute('sizes')).toBe(false)
		expect(doc.querySelector('picture source')).toBeNull()
	})

	it('hides the whole figure, not just the image, when the record has no cover', () => {
		const doc = parse(buildPreviewDocument(TEMPLATE, { title: 'T', markdown: 'x', imageUrl: null }))
		expect(doc.querySelector('figure.hero')?.hasAttribute('hidden')).toBe(true)
		// The body next to it stays visible.
		expect(slot(doc, 'body')?.closest('[hidden]')).toBeNull()

		fillPreviewSlots(doc, TEMPLATE.classMap, {
			title: 'T',
			markdown: 'x',
			imageUrl: 'https://cdn.example.com/cover.png',
		})
		expect(doc.querySelector('figure.hero')?.hasAttribute('hidden')).toBe(false)
		expect(slot(doc, 'image')?.getAttribute('src')).toBe('https://cdn.example.com/cover.png')
	})

	it('does not show the sample image when the record has none', () => {
		const doc = parse(buildPreviewDocument(TEMPLATE, { title: 'T', markdown: 'x', imageUrl: null }))
		const img = slot(doc, 'image')
		expect(img === null || img.hasAttribute('hidden') || img.closest('[hidden]') !== null).toBe(
			true,
		)
		expect(doc.body.innerHTML).not.toContain('sample.jpg')
	})

	it('keeps scripts out of the preview and locks the frame down with a CSP and a blank-target base', () => {
		const out = buildPreviewDocument(TEMPLATE, {
			title: '<img src=x onerror=alert(1)>',
			markdown:
				'Hi <script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[x](javascript:alert(3))\n\n<iframe src="https://evil.example"></iframe>\n\n<a href="#" onclick="alert(4)">a</a>',
		})
		expect(out).not.toMatch(/<script\b/i)
		expect(out).not.toMatch(/javascript:/i)
		expect(out).not.toMatch(/<iframe\b/i)

		const doc = parse(out)
		expect(
			Array.from(doc.querySelectorAll('*')).flatMap((element) =>
				Array.from(element.attributes).filter((attribute) => /^on/i.test(attribute.name)),
			),
		).toEqual([])
		// The title is text, not markup.
		expect(slot(doc, 'title')?.textContent).toBe('<img src=x onerror=alert(1)>')
		const csp = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')
		expect(csp).not.toBeNull()
		expect(doc.head.firstElementChild?.matches('meta[charset], meta[http-equiv]')).toBe(true)
		expect(csp?.getAttribute('content')).toMatch(/script-src 'none'/)
		const base = doc.head.querySelectorAll('base')
		expect(base).toHaveLength(1)
		expect(base[0].getAttribute('href')).toBe('https://blog.example.com/posts/sample')
		expect(base[0].getAttribute('target')).toBe('_blank')
	})

	it('copes with a template that has no title or image slot', () => {
		const bare: PreviewTemplateData = {
			html: '<!DOCTYPE html><html><head><title>x</title></head><body><main data-innolope-slot="body"></main></body></html>',
			classMap: {},
		}
		const doc = parse(buildPreviewDocument(bare, { title: 'Only body', markdown: '## Hi' }))
		expect(slot(doc, 'body')?.querySelector('h2')?.textContent).toBe('Hi')
		expect(doc.title).toBe('Only body')
	})
})

describe('fillPreviewSlots', () => {
	it('updates an already-rendered preview in place without touching its styles', () => {
		const doc = parse(buildPreviewDocument(TEMPLATE, { title: 'Draft', markdown: 'Old text.' }))
		const styleBefore = doc.querySelector('style[data-innolope-href]')

		fillPreviewSlots(doc, TEMPLATE.classMap, {
			title: 'Draft, edited',
			markdown: 'New text.\n\n## Added',
		})

		expect(slot(doc, 'title')?.textContent).toBe('Draft, edited')
		expect(doc.title).toBe('Draft, edited')
		const body = slot(doc, 'body') as Element
		expect(body.textContent).not.toContain('Old text.')
		expect(body.querySelector('p')?.textContent).toBe('New text.')
		expect(body.querySelector('h2')?.className).toBe('mt-10 text-2xl')
		// Same node, not a re-parse: the preview keeps its loaded CSS and scroll position.
		expect(doc.querySelector('style[data-innolope-href]')).toBe(styleBefore)
	})
})
