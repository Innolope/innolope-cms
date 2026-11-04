import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	capturePreviewTemplate,
	PreviewCaptureError,
	type PreviewCaptureErrorCode,
	type PreviewTemplate,
} from './preview-template.js'

const validatePublicUrl = vi.hoisted(() => vi.fn(async (_url: string) => null as string | null))
const safeFetch = vi.hoisted(() =>
	vi.fn(
		async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
			new Response('', { status: 404 }),
	),
)
vi.mock('../adapters/connection-guard.js', () => ({ validatePublicUrl, safeFetch }))

const PAGE = 'https://blog.example.com/posts/hello-world'
const HTML = { 'content-type': 'text/html; charset=utf-8' }

interface Route {
	status?: number
	body?: string | Uint8Array
	headers?: Record<string, string>
}

/** Serve fixed responses by exact URL; anything else is a 404. */
function serve(routes: Record<string, Route>) {
	safeFetch.mockImplementation(async (url) => {
		const route = routes[String(url)]
		if (!route)
			return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
		return new Response(route.body ?? '', {
			status: route.status ?? 200,
			headers: route.headers ?? HTML,
		})
	})
}

function page(body: string, head = ''): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hello world – Example Blog</title>${head}</head><body>${body}</body></html>`
}

function paragraphs(n: number, cls = ''): string {
	return Array.from(
		{ length: n },
		(_, i) =>
			`<p${cls ? ` class="${cls}"` : ''}>Paragraph ${i + 1} of the sample article. It carries enough words to read like real prose, so a detector treats it as body text rather than as the chrome around the article.</p>`,
	).join('')
}

const HEADER = `<header class="site-header"><a href="/" class="logo"><img src="/logo.svg" alt="Example"></a><nav><a href="/about">About us</a><a href="/blog">Blog</a></nav></header>`
const FOOTER = `<footer class="site-footer"><p>© 2026 Example Inc.</p></footer>`

/** The opening tag of the element carrying `data-innolope-slot="<slot>"`, or null. */
function slotTag(html: string, slot: string): string | null {
	const re = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*data-innolope-slot="${slot}"[^>]*>`, 'i')
	return re.exec(html)?.[0] ?? null
}

async function captureError(
	url: string,
	options?: Parameters<typeof capturePreviewTemplate>[1],
): Promise<PreviewCaptureError> {
	try {
		await capturePreviewTemplate(url, options)
	} catch (err) {
		expect(err).toBeInstanceOf(PreviewCaptureError)
		return err as PreviewCaptureError
	}
	throw new Error('expected capturePreviewTemplate to throw')
}

beforeEach(() => {
	validatePublicUrl.mockReset()
	validatePublicUrl.mockResolvedValue(null)
	safeFetch.mockReset()
	serve({})
})

describe('capturePreviewTemplate: input and fetch failures', () => {
	it.each([
		'',
		'not a url',
		'ftp://blog.example.com/a',
		'javascript:alert(1)',
		'file:///etc/passwd',
		'data:text/html,<h1>x</h1>',
	])('rejects %j with INVALID_URL without fetching', async (url) => {
		const err = await captureError(url)
		expect(err.code).toBe<PreviewCaptureErrorCode>('INVALID_URL')
		expect(safeFetch).not.toHaveBeenCalled()
	})

	it('refuses private or internal targets with BLOCKED_URL before fetching', async () => {
		validatePublicUrl.mockResolvedValue('Requests to private/internal addresses are not allowed.')
		const err = await captureError('http://169.254.169.254/latest/meta-data')
		expect(err.code).toBe('BLOCKED_URL')
		expect(safeFetch).not.toHaveBeenCalled()
	})

	it('reports a network or redirect-hop failure as FETCH_FAILED', async () => {
		safeFetch.mockRejectedValue(new Error('Request to private/internal addresses is not allowed.'))
		const err = await captureError(PAGE)
		expect(err.code).toBe('FETCH_FAILED')
	})

	it.each<[string, Route]>([
		[
			'a Cloudflare challenge',
			{
				status: 403,
				body: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>',
				headers: { ...HTML, 'cf-mitigated': 'challenge' },
			},
		],
		['a plain 403', { status: 403, body: 'Forbidden' }],
		['a 401', { status: 401, body: 'Unauthorized' }],
		['rate limiting', { status: 429, body: 'Too many requests' }],
	])('reports %s as BLOCKED_BY_SITE', async (_label, route) => {
		serve({ [PAGE]: route })
		const err = await captureError(PAGE)
		expect(err.code).toBe('BLOCKED_BY_SITE')
	})

	it.each([404, 410, 500, 502])('reports HTTP %i as FETCH_FAILED', async (status) => {
		serve({ [PAGE]: { status, body: 'nope' } })
		const err = await captureError(PAGE)
		expect(err.code).toBe('FETCH_FAILED')
	})

	it.each([
		'application/pdf',
		'application/json',
		'image/png',
	])('reports a %s response as NOT_HTML', async (type) => {
		serve({ [PAGE]: { body: '{}', headers: { 'content-type': type } } })
		const err = await captureError(PAGE)
		expect(err.code).toBe('NOT_HTML')
	})

	it('reports a page over the size limit as TOO_LARGE', async () => {
		serve({ [PAGE]: { body: page(`<article><h1>Big</h1>${paragraphs(40)}</article>`) } })
		const err = await captureError(PAGE, { limits: { pageBytes: 1_000 } })
		expect(err.code).toBe('TOO_LARGE')
	})

	it('gives every outbound request an abort signal so a slow site cannot hang the capture', async () => {
		serve({
			[PAGE]: {
				body: page(
					`<article><h1>Hello world</h1><div class="post-body">${paragraphs(5)}</div></article>`,
					'<link rel="stylesheet" href="/css/main.css">',
				),
			},
			'https://blog.example.com/css/main.css': {
				body: 'body{color:#111}',
				headers: { 'content-type': 'text/css' },
			},
		})
		await capturePreviewTemplate(PAGE)
		expect(safeFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
		for (const [, init] of safeFetch.mock.calls) {
			expect(init?.signal).toBeInstanceOf(AbortSignal)
		}
	})
})

describe('capturePreviewTemplate: finding the article', () => {
	it('marks the h1 and the paragraph container in a semantic article, keeping the site chrome', async () => {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<main><article><h1 class="post-title">Hello world</h1><p class="byline">By Ada</p><div class="post-body">${paragraphs(6)}</div></article><aside class="related"><h3>Related</h3><a href="/posts/other">Other post</a></aside></main>${FOOTER}`,
				),
			},
		})
		const t = await capturePreviewTemplate(PAGE)

		expect(t.sourceUrl).toBe(PAGE)
		expect(t.finalUrl).toBe(PAGE)
		expect(Number.isNaN(Date.parse(t.capturedAt))).toBe(false)
		expect(slotTag(t.html, 'title')).toMatch(/^<h1\b/i)
		expect(slotTag(t.html, 'body')).toMatch(/class="post-body"/)
		expect(t.slots.body.strategy).toMatch(/^(semantic|heuristic)$/)
		expect(t.slots.title?.selector).toBeTruthy()
		// The sample article's own prose is gone; the chrome around it stays.
		expect(t.html).not.toContain('Paragraph 3 of the sample article')
		expect(t.html).toContain('About us')
		expect(t.html).toContain('© 2026 Example Inc.')
		expect(t.html).toContain('Other post')
	})

	it('harvests the per-element classes of a utility-class site into classMap', async () => {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<main class="mx-auto max-w-2xl"><h1 class="text-4xl font-bold tracking-tight">Hello world</h1><div class="mt-8">${paragraphs(5, 'mb-6 text-lg leading-8')}<h2 class="mt-10 text-2xl font-semibold">A section</h2>${paragraphs(2, 'mb-6 text-lg leading-8')}<ul class="list-disc pl-6"><li class="mb-2">One point</li><li class="mb-2">Another point</li></ul><p class="mb-6 text-lg leading-8">See <a class="text-blue-600 underline" href="/docs">the docs</a> and use <code class="rounded bg-gray-100 px-1">npm i</code>.</p></div></main>${FOOTER}`,
				),
			},
		})
		const t = await capturePreviewTemplate(PAGE)

		expect(slotTag(t.html, 'body')).toMatch(/class="mt-8"/)
		expect(t.classMap.p).toBe('mb-6 text-lg leading-8')
		expect(t.classMap.h2).toBe('mt-10 text-2xl font-semibold')
		expect(t.classMap.ul).toBe('list-disc pl-6')
		expect(t.classMap.li).toBe('mb-2')
		expect(t.classMap.a).toBe('text-blue-600 underline')
		expect(t.classMap.code).toBe('rounded bg-gray-100 px-1')
	})

	it('finds a WordPress post, its title and the og:image hero', async () => {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<div id="content"><article class="post type-post"><header class="entry-header"><h1 class="entry-title">Hello world</h1></header><div class="post-thumbnail"><img class="wp-post-image" src="/wp-content/uploads/2026/10/hero-1024x576.jpg" srcset="/wp-content/uploads/2026/10/hero-1024x576.jpg 1024w, /wp-content/uploads/2026/10/hero.jpg 1600w" alt=""></div><div class="entry-content">${paragraphs(6)}</div></article></div>${FOOTER}`,
					'<meta property="og:image" content="https://blog.example.com/wp-content/uploads/2026/10/hero.jpg">',
				),
			},
		})
		const t = await capturePreviewTemplate(PAGE)

		expect(slotTag(t.html, 'title')).toMatch(/class="entry-title"/)
		expect(slotTag(t.html, 'body')).toMatch(/class="entry-content"/)
		expect(slotTag(t.html, 'image')).toMatch(/^<img\b/i)
		expect(slotTag(t.html, 'image')).toMatch(/wp-post-image/)
		expect(t.slots.image).not.toBeNull()
	})

	it('uses a known title to pick the right heading when the page has several h1s', async () => {
		serve({
			[PAGE]: {
				body: page(
					`<header><h1 class="brand">Example Blog</h1></header><main><section class="hero"><h1 class="headline">How we cut build times in half</h1></section><div class="content">${paragraphs(5)}</div></main>`,
				),
			},
		})
		const t = await capturePreviewTemplate(PAGE, {
			hints: { title: 'How we cut build times in half' },
		})
		expect(slotTag(t.html, 'title')).toMatch(/class="headline"/)
		expect(t.slots.title?.strategy).toBe('record-match')
	})

	it('honours selector overrides and reports a selector that matches nothing', async () => {
		serve({
			[PAGE]: {
				body: page(
					`<main><h1>Hello world</h1><div class="lead"><p>A short standfirst.</p></div><div id="custom">${paragraphs(4)}</div><div class="other">${paragraphs(6)}</div></main>`,
				),
			},
		})
		const t = await capturePreviewTemplate(PAGE, { selectors: { body: '#custom' } })
		expect(slotTag(t.html, 'body')).toMatch(/id="custom"/)
		expect(t.slots.body.strategy).toBe('override')
		expect(t.slots.body.selector).toBe('#custom')

		const err = await captureError(PAGE, { selectors: { body: '.does-not-exist' } })
		expect(err.code).toBe('SELECTOR_NOT_FOUND')
	})

	it.each([
		'<div id="__next"></div><script src="/_next/static/chunks/main.js"></script>',
		'<div id="root"></div><script type="module" src="/assets/index-abc123.js"></script>',
		'<div id="app"><noscript>You need to enable JavaScript to run this app.</noscript></div><script src="/js/app.js"></script>',
	])('reports a client-rendered shell as CLIENT_RENDERED: %s', async (body) => {
		serve({ [PAGE]: { body: page(body) } })
		const err = await captureError(PAGE)
		expect(err.code).toBe('CLIENT_RENDERED')
	})

	it('reports a server-rendered page without any article prose as NO_ARTICLE_FOUND', async () => {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<main><h1>Our products</h1><ul><li><a href="/p/1">Widget</a></li><li><a href="/p/2">Gadget</a></li></ul></main>${FOOTER}`,
				),
			},
		})
		const err = await captureError(PAGE)
		expect(err.code).toBe('NO_ARTICLE_FOUND')
	})
})

describe('capturePreviewTemplate: making the page safe and self-contained', () => {
	async function captureHostile(): Promise<PreviewTemplate> {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<article onclick="steal()"><h1 onmouseover="steal()">Hello world</h1><div class="post-body">${paragraphs(5)}</div><a href="javascript:steal()">click</a><a href="JaVaScRiPt:steal()">click2</a><iframe src="https://evil.example/frame"></iframe><object data="/x.swf"></object><embed src="/x.swf"><form action="https://evil.example/collect"><input name="q"></form><svg><script>steal()</script></svg></article><script>steal()</script><script src="/app.js"></script><script type="application/ld+json">{"@type":"Article"}</script>${FOOTER}`,
					'<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="preload" href="/app.js" as="script"><link rel="modulepreload" href="/m.js"><link rel="prefetch" href="/next.html"><script>steal()</script>',
				),
			},
		})
		return capturePreviewTemplate(PAGE)
	}

	it('strips scripts, event handlers, javascript: URLs, refreshes, embeds and script preloads', async () => {
		const { html } = await captureHostile()
		expect(html).not.toMatch(/<script\b/i)
		expect(html).not.toMatch(/\son[a-z]+\s*=/i)
		expect(html).not.toMatch(/javascript:/i)
		expect(html).not.toMatch(/http-equiv\s*=\s*["']?refresh/i)
		expect(html).not.toMatch(/<(iframe|object|embed)\b/i)
		expect(html).not.toMatch(/rel="(preload|modulepreload|prefetch)"/i)
		expect(html).not.toContain('evil.example')
	})

	it('pins exactly one <base> to the page URL', async () => {
		const { html } = await captureHostile()
		const bases = html.match(/<base\b[^>]*>/gi) ?? []
		expect(bases).toHaveLength(1)
		expect(bases[0]).toContain(`href="${PAGE}"`)
	})

	it('makes resource URLs absolute and promotes lazy-loaded image sources', async () => {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<article><h1>Hello world</h1><div class="post-body">${paragraphs(5)}</div></article><section class="more"><img class="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/card.jpg" data-srcset="/img/card.jpg 1x, /img/card@2x.jpg 2x" alt="card"></section>${FOOTER}`,
				),
			},
		})
		const { html } = await capturePreviewTemplate(PAGE)
		expect(html).toContain('src="https://blog.example.com/logo.svg"')
		expect(html).toContain('href="https://blog.example.com/about"')
		expect(html).toContain('src="https://blog.example.com/img/card.jpg"')
		expect(html).toContain('https://blog.example.com/img/card@2x.jpg 2x')
	})
})

describe('capturePreviewTemplate: stylesheets and fonts', () => {
	const CSS = { 'content-type': 'text/css; charset=utf-8' }
	const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4])

	function articleWith(head: string): string {
		return page(
			`${HEADER}<article><h1>Hello world</h1><div class="post-body">${paragraphs(5)}</div></article>${FOOTER}`,
			head,
		)
	}

	it('inlines stylesheets, rewriting url() against the stylesheet and following @import', async () => {
		serve({
			[PAGE]: { body: articleWith('<link rel="stylesheet" href="/css/main.css">') },
			'https://blog.example.com/css/main.css': {
				body: '@import url("base.css");\n.hero{background:url(../img/bg.png)}\n.icon{background:url("/img/icon.svg")}',
				headers: CSS,
			},
			'https://blog.example.com/css/base.css': {
				body: 'body{font-family:Georgia,serif;background:url(paper.png)}',
				headers: CSS,
			},
		})
		const t = await capturePreviewTemplate(PAGE)

		expect(t.html).not.toMatch(/<link\b[^>]*rel="stylesheet"/i)
		expect(t.html).toMatch(
			/<style\b[^>]*data-innolope-href="https:\/\/blog\.example\.com\/css\/main\.css"/,
		)
		expect(t.html).toContain('https://blog.example.com/img/bg.png')
		expect(t.html).toContain('https://blog.example.com/img/icon.svg')
		expect(t.html).toContain('font-family:Georgia,serif')
		expect(t.html).toContain('https://blog.example.com/css/paper.png')
		expect(t.stats.stylesheets).toBeGreaterThanOrEqual(1)
	})

	it('keeps url(#id) pointing into the page instead of resolving it against the site', async () => {
		serve({
			[PAGE]: {
				body: page(
					`${HEADER}<article><h1>Hello world</h1><svg><linearGradient id="brand"/><clipPath id="clip"/></svg><div class="post-body" style="clip-path:url(#clip)">${paragraphs(5)}</div></article>${FOOTER}`,
					'<link rel="stylesheet" href="/css/main.css"><style>.mark{mask:url(\'#clip\')}</style>',
				),
			},
			'https://blog.example.com/css/main.css': {
				body: '.logo path{fill:url(#brand)}.hero{background:url(img/bg.png)}',
				headers: CSS,
			},
		})
		const t = await capturePreviewTemplate(PAGE)

		expect(t.html).toContain('fill:url(#brand)')
		expect(t.html).toContain("mask:url('#clip')")
		expect(t.html).toContain('clip-path:url(#clip)')
		expect(t.html).not.toContain(`${PAGE}#`)
		expect(t.html).toContain('https://blog.example.com/css/img/bg.png')
	})

	it('keeps an absolute <link> and warns when a stylesheet cannot be fetched', async () => {
		serve({ [PAGE]: { body: articleWith('<link rel="stylesheet" href="/css/missing.css">') } })
		const t = await capturePreviewTemplate(PAGE)
		expect(t.html).toMatch(/<link\b[^>]*href="https:\/\/blog\.example\.com\/css\/missing\.css"/)
		expect(t.warnings.join(' ')).toMatch(/missing\.css/)
	})

	it('inlines fonts the browser could not load cross-origin and leaves CORS-enabled fonts alone', async () => {
		serve({
			[PAGE]: { body: articleWith('<link rel="stylesheet" href="/css/fonts.css">') },
			'https://blog.example.com/css/fonts.css': {
				body: '@font-face{font-family:Brand;src:url(/fonts/brand.woff2) format("woff2")}\n@font-face{font-family:Open;src:url(https://fonts.example-cdn.com/open.woff2) format("woff2")}',
				headers: CSS,
			},
			'https://blog.example.com/fonts/brand.woff2': {
				body: FONT,
				headers: { 'content-type': 'font/woff2' },
			},
			'https://fonts.example-cdn.com/open.woff2': {
				body: FONT,
				headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' },
			},
		})
		const t = await capturePreviewTemplate(PAGE)

		expect(t.html).toMatch(/url\(["']?data:font\/woff2;base64,/)
		expect(t.html).not.toContain('https://blog.example.com/fonts/brand.woff2')
		expect(t.html).toContain('https://fonts.example-cdn.com/open.woff2')
		expect(t.stats.inlinedFonts).toBe(1)
	})

	it('stops inlining past the stylesheet cap, keeping the rest as links with a warning', async () => {
		const links = Array.from(
			{ length: 4 },
			(_, i) => `<link rel="stylesheet" href="/css/s${i}.css">`,
		).join('')
		const routes: Record<string, Route> = { [PAGE]: { body: articleWith(links) } }
		for (let i = 0; i < 4; i++) {
			routes[`https://blog.example.com/css/s${i}.css`] = { body: `.s${i}{color:red}`, headers: CSS }
		}
		serve(routes)
		const t = await capturePreviewTemplate(PAGE, { limits: { maxStylesheets: 2 } })
		expect(t.stats.stylesheets).toBe(2)
		expect((t.html.match(/<link\b[^>]*rel="stylesheet"/gi) ?? []).length).toBe(2)
		expect(t.warnings.length).toBeGreaterThan(0)
	})
})
