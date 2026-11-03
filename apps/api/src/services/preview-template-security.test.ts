import { execFileSync } from 'node:child_process'
import { load as loadSlim } from 'cheerio/slim'
import { parse } from 'parse5'
import { adapter } from 'parse5-htmlparser2-tree-adapter'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePreviewTemplate, PreviewCaptureError } from './preview-template.js'

const load = (html: string) => loadSlim(parse(html, { treeAdapter: adapter }))

const validatePublicUrl = vi.hoisted(() => vi.fn(async (_url: string) => null as string | null))
const safeFetch = vi.hoisted(() =>
	vi.fn(
		async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
			new Response('', { status: 404 }),
	),
)
vi.mock('../adapters/connection-guard.js', () => ({ validatePublicUrl, safeFetch }))

const PAGE = 'https://blog.example.com/article'
const CSS = 'https://blog.example.com/main.css'
const article =
	'<article id="article"><header id="title-wrapper"><h1 id="title">Sample title</h1></header><figure id="image-wrapper"><picture><img id="image" src="/hero.jpg"></picture></figure>Loose obsolete text<!-- obsolete comment --><p id="obsolete">Sample prose to remove.</p><section id="obsolete-section"><p>More obsolete prose.</p></section></article>'
const selectors = { body: '#article', title: '#title', image: '#image' }

beforeEach(() => {
	validatePublicUrl.mockReset().mockResolvedValue(null)
	safeFetch.mockReset()
})

describe('capture preview supplemental contract: A10', () => {
	it('does not install a process-wide fetch dispatcher when the service is imported', () => {
		const script = `const keys = ['undici.globalDispatcher.1', 'undici.globalDispatcher.2'].map(Symbol.for)
const before = keys.map(key => globalThis[key])
await import('./src/services/preview-template.ts')
console.log(JSON.stringify(keys.map((key, index) => globalThis[key] === before[index])))`
		const output = execFileSync(
			process.execPath,
			['--import', 'tsx', '--input-type=module', '-e', script],
			{ encoding: 'utf8', timeout: 15_000 },
		)
		expect(JSON.parse(output.trim())).toEqual([true, true])
	})
	it.each([
		'</style>',
		'</StYlE >',
	])('keeps fetched CSS raw-text breakout %s inert after serialization', async (closingTag) => {
		const css = `body{color:navy}/* ${closingTag}<script id="escaped-script">alert(1)</script><img id="escaped-image" src=x onerror="alert(1)"><style> */`
		safeFetch.mockImplementation(
			async (url) =>
				new Response(
					String(url) === CSS
						? css
						: `<!doctype html><html><head><link rel="stylesheet" href="${CSS}"></head><body>${article}</body></html>`,
					{
						headers: { 'content-type': String(url) === CSS ? 'text/css' : 'text/html' },
					},
				),
		)
		const result = await capturePreviewTemplate(PAGE, { selectors })
		const $ = load(result.html)
		expect($('style').text()).toContain('color:navy')
		expect($('#escaped-script, #escaped-image')).toHaveLength(0)
		expect($('script, [onerror]')).toHaveLength(0)
	})

	it('empties all ordinary direct body children while preserving nested title and image ancestors', async () => {
		safeFetch.mockResolvedValue(
			new Response(`<html><head></head><body>${article}</body></html>`, {
				headers: { 'content-type': 'text/html' },
			}),
		)
		const result = await capturePreviewTemplate(PAGE, { selectors })
		const $ = load(result.html)
		const body = $('[data-innolope-slot="body"]')
		expect(body.find('#title-wrapper [data-innolope-slot="title"]')).toHaveLength(1)
		expect(body.find('#image-wrapper [data-innolope-slot="image"]')).toHaveLength(1)
		expect(body.find('#obsolete, #obsolete-section')).toHaveLength(0)
		expect(body.html()).not.toContain('Loose obsolete text')
		expect(body.html()).not.toContain('obsolete comment')
	})
})

describe('capture preview supplemental contract: A8', () => {
	it('cancels a response whose content-length exceeds the budget without reading', async () => {
		const cancel = vi.fn()
		safeFetch.mockResolvedValue(
			new Response(new ReadableStream({ cancel }), {
				headers: { 'content-type': 'text/html', 'content-length': '1025' },
			}),
		)
		await expect(
			capturePreviewTemplate(PAGE, { limits: { pageBytes: 1024 } }),
		).rejects.toMatchObject({ code: 'TOO_LARGE' })
		expect(cancel).toHaveBeenCalledOnce()
	})
	it.each([
		'requestTimeoutMs',
		'totalTimeoutMs',
	] as const)('bounds a stalled body by %s and cancels it', async (key) => {
		const cancel = vi.fn()
		safeFetch.mockResolvedValue(
			new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } }),
		)
		await expect(capturePreviewTemplate(PAGE, { limits: { [key]: 20 } })).rejects.toMatchObject({
			code: 'FETCH_FAILED',
		})
		expect(cancel).toHaveBeenCalledOnce()
		expect(safeFetch).toHaveBeenCalledOnce()
	})
	it('bounds a stalled fetch without retrying it', async () => {
		safeFetch.mockImplementation(() => new Promise(() => {}))
		await expect(
			capturePreviewTemplate(PAGE, { limits: { requestTimeoutMs: 20 } }),
		).rejects.toMatchObject({ code: 'FETCH_FAILED' })
		expect(safeFetch).toHaveBeenCalledOnce()
	})
	it('cancels an oversized open response stream rather than reading to EOF', async () => {
		const cancel = vi.fn()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(1025)))
			},
			cancel,
		})
		safeFetch.mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/html' } }))
		let error: unknown
		try {
			await capturePreviewTemplate(PAGE, { limits: { pageBytes: 1024 } })
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(PreviewCaptureError)
		expect((error as PreviewCaptureError).code).toBe('TOO_LARGE')
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(safeFetch).toHaveBeenCalledTimes(1)
	})
})

describe('capture additional boundary contracts', () => {
	const body = `<article><h1>Sample</h1><div class="post-body">${Array.from({ length: 3 }, () => `<p class="prose-p">${'Long article prose with enough words to be a useful paragraph. '.repeat(4)}</p>`).join('')}</div></article>`
	function servePage(head = '', content = body) {
		safeFetch.mockResolvedValue(
			new Response(`<html><head>${head}</head><body>${content}</body></html>`, {
				headers: { 'content-type': 'text/html' },
			}),
		)
	}
	it('identifies a successful-status challenge even without a title or challenge header', async () => {
		servePage('', '<main>Just a moment...</main>')
		await expect(capturePreviewTemplate(PAGE)).rejects.toMatchObject({ code: 'BLOCKED_BY_SITE' })
	})
	it.each([
		['body', (page: string) => page],
		['main', (page: string) => `<main class="site-main has-sidebar">${page}</main>`],
		[
			'article',
			(page: string) =>
				page.replace('<article>', '<article class="post type-post tag-newsletter category-ad">'),
		],
	])('ignores layout and taxonomy classes on the page <%s>', async (_where, wrap) => {
		safeFetch.mockResolvedValue(
			new Response(
				`<html><head></head><body class="single menu-open nav-is-sticky">${wrap(body)}</body></html>`,
				{ headers: { 'content-type': 'text/html' } },
			),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.body?.sample).toContain('long article prose')
		expect(result.slots.title?.sample).toBe('sample')
	})
	it("finds the title in the article's own header even when that header holds a tag nav", async () => {
		servePage(
			'',
			`<header class="site"><nav><a href="/">Home</a></nav></header><article><header><nav><a href="/tags/x">x</a></nav><h1>Article heading</h1></header>${body.replace('<article><h1>Sample</h1>', '').replace('</article>', '')}</article>`,
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.title?.sample).toBe('article heading')
	})
	it('still skips a heading inside the navigation-carrying site header', async () => {
		servePage(
			'',
			`<header><nav><a href="/">Home</a></nav><h1>Site name</h1></header><main>${body.replace('<h1>Sample</h1>', '')}</main>`,
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.title).toBeNull()
	})
	it('ignores chrome words inside Tailwind arbitrary-variant classes', async () => {
		servePage(
			'',
			body.replace(
				'class="post-body"',
				'class="post-body w-full [&_[data-issue-comment-header]_p]:text-sm @lg:[&_nav]:hidden"',
			),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.body?.sample).toContain('long article prose')
	})
	it('prefers the h1 that names the page over a site-name h1 above it', async () => {
		servePage(
			'<title>Release notes are out - Example Site</title>',
			body
				.replace(
					'<article><h1>Sample</h1>',
					'<div class="Article"><h1 class="small"><a href="/blog/">Example Site</a></h1><h1>Release notes are out</h1>',
				)
				.replace('</article>', '</div>'),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.title?.sample).toBe('release notes are out')
	})
	it('takes an article split into sibling sections as one body', async () => {
		const section = (id: string) =>
			`<section id="${id}"><h2>${id}</h2>${Array.from({ length: 3 }, () => `<p>${`Section ${id} prose that reads like an article paragraph. `.repeat(3)}</p>`).join('')}</section>`
		servePage(
			'',
			`<main><h1>Sectioned</h1><div class="paper">${section('first')}${section('second')}${section('third')}</div></main>`,
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.body?.selector).toBe('div.paper')
		expect(result.slots.body?.sample).toMatch(/^first\s*section first prose/)
	})
	it('follows an instant meta-refresh page to the article, through the guarded fetch', async () => {
		const moved = 'https://blog.example.com/posts/moved/'
		safeFetch.mockImplementation(async (url) =>
			String(url) === PAGE
				? new Response(
						`<!doctype html><title>Redirect</title><script>location.replace("${moved}")</script><noscript><meta http-equiv="refresh" content="0; url=${moved}"></noscript><p><a href="${moved}">Click here</a></p>`,
						{ headers: { 'content-type': 'text/html' } },
					)
				: new Response(`<html><head></head><body>${body}</body></html>`, {
						headers: { 'content-type': 'text/html' },
					}),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(safeFetch.mock.calls.map(([url]) => String(url))).toEqual([PAGE, moved])
		expect(result.finalUrl).toBe(moved)
		expect(result.slots.title?.sample).toBe('sample')
	})
	it.each([
		['a delayed refresh on a full article', `<meta http-equiv="refresh" content="300">${body}`],
		[
			'a refresh loop',
			`<meta http-equiv="refresh" content="0; url=${'https://blog.example.com/post'}">`,
		],
	])('does not follow %s', async (_label, content) => {
		servePage('', content)
		await capturePreviewTemplate(PAGE).catch(() => undefined)
		expect(safeFetch.mock.calls.length).toBeLessThanOrEqual(4)
		if (content.includes('300')) expect(safeFetch).toHaveBeenCalledOnce()
	})
	it("captures a normal page that carries Cloudflare's passive bot-detection beacon", async () => {
		servePage(
			`<script>var u='/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=a54cd40cdf284afd'</script>`,
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.body).not.toBeNull()
	})
	it('identifies a successful-status challenge by its challenge options script', async () => {
		servePage(
			'<title>innolope.com</title>',
			`<div id="challenge-stage"></div><script>window._cf_chl_opt={cType:'managed'}</script>${body}`,
		)
		await expect(capturePreviewTemplate(PAGE)).rejects.toMatchObject({ code: 'BLOCKED_BY_SITE' })
	})
	it('finds a known title outside the nearest article but within the page main', async () => {
		servePage('', `<main><h1>Known heading</h1>${body}</main>`)
		const result = await capturePreviewTemplate(PAGE, { hints: { title: 'Known heading' } })
		expect(result.slots.title?.strategy).toBe('record-match')
		expect(load(result.html)('[data-innolope-slot="title"]').text()).toBe('Known heading')
	})
	it('preserves commas inside srcset data URLs while resolving relative candidates', async () => {
		servePage('', `${body}<img srcset="data:image/png;base64,AAAA 1x, /large.png 2x">`)
		const $ = load((await capturePreviewTemplate(PAGE)).html)
		expect($('img').attr('srcset')).toBe(
			'data:image/png;base64,AAAA 1x, https://blog.example.com/large.png 2x',
		)
	})
	it('keeps 40 generated obfuscated scheme/event combinations inert (seed 531)', async () => {
		let seed = 531
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed
		}
		for (let i = 0; i < 40; i++) {
			const scheme = ['javascript:alert(1)', 'vbscript:bad', 'data:text/html,bad'][i % 3]
			const encoded = Array.from(scheme)
				.map((char) => {
					const transformed = next() % 2 ? char.toUpperCase() : char
					return `${next() % 2 ? `&#${transformed.charCodeAt(0)};` : transformed}${next() % 3 === 0 ? '&#9;' : ''}`
				})
				.join('')
			servePage(
				'',
				`${body}<section><a href="${encoded}" ONmouseover="bad()">link</a><img src="${encoded}" onerror="bad()"></section>`,
			)
			const $ = load((await capturePreviewTemplate(PAGE)).html)
			expect($('body [href],body [src],body [onerror],body [onmouseover]')).toHaveLength(0)
		}
	})
	it('isolates budgets and results for three concurrent captures', async () => {
		safeFetch.mockImplementation(
			async () =>
				new Response(`<html><body>${body}</body></html>`, {
					headers: { 'content-type': 'text/html' },
				}),
		)
		const results = await Promise.allSettled([
			capturePreviewTemplate(PAGE),
			capturePreviewTemplate(PAGE, { limits: { pageBytes: 4 } }),
			capturePreviewTemplate(PAGE),
		])
		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
		if (results[0].status === 'fulfilled' && results[2].status === 'fulfilled')
			expect(results[0].value.html).toBe(results[2].value.html)
	})
	it('keeps a CORS font without buffering it or spending the inline font budget', async () => {
		const cancel = vi.fn()
		safeFetch.mockImplementation(async (url) =>
			String(url) === PAGE
				? new Response(
						`<html><head><style>@font-face{font-family:A;src:url(/cors.woff2)}</style></head><body>${body}</body></html>`,
						{ headers: { 'content-type': 'text/html' } },
					)
				: new Response(new ReadableStream({ cancel }), {
						headers: {
							'content-type': 'font/woff2',
							'access-control-allow-origin': '*',
							'content-length': '9999999',
						},
					}),
		)
		const result = await capturePreviewTemplate(PAGE, { limits: { totalFontBytes: 1 } })
		expect(result.stats.inlinedFonts).toBe(0)
		expect(result.warnings).toEqual([])
		expect(result.html).toContain('https://blog.example.com/cors.woff2')
		expect(cancel).toHaveBeenCalledOnce()
	})
	it('preserves CSS strings/comments while rewriting URL tokens and CSS escapes', async () => {
		const css =
			'.x::before{content:"url(icon.svg) @import \\"fake.css\\";"}/* url(comment.svg) @import "comment.css"; */ .x{background:URL(\\69 con.svg)}'
		servePage(`<style>${css}</style>`)
		const result = await capturePreviewTemplate(PAGE)
		const text = load(result.html)('style').text()
		expect(text).toContain('content:"url(icon.svg)')
		expect(text).toContain('/* url(comment.svg) @import "comment.css"; */')
		expect(text).toContain('https://blog.example.com/icon.svg')
		expect(safeFetch).toHaveBeenCalledOnce()
	})
	it.each([
		'iframe',
		'object',
		'portal',
		'noscript',
	])('rejects a body override removed by sanitization: %s', async (tag) => {
		servePage('', `${body}<${tag} id="removed">fallback</${tag}>`)
		await expect(
			capturePreviewTemplate(PAGE, { selectors: { body: '#removed' } }),
		).rejects.toMatchObject({ code: 'SELECTOR_NOT_FOUND' })
	})
	it('does not select prose inside an active embed that sanitization removes', async () => {
		servePage('', `<object>${body}</object><main><h1>No article here</h1></main>`)
		await expect(capturePreviewTemplate(PAGE)).rejects.toMatchObject({ code: 'NO_ARTICLE_FOUND' })
	})
	it('finds a large hero before a nested body, across wrapping siblings', async () => {
		servePage(
			'',
			body
				.replace(
					'<article>',
					'<article><figure><img src="/hero.jpg" width="1200" height="600"></figure><section>',
				)
				.replace('</article>', '</section></article>'),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image).not.toBeNull()
	})
	it.each([
		'title',
		'body',
		'image',
	] as const)('reports absent and invalid %s overrides with an actionable 400', async (slot) => {
		for (const selector of ['.absent', '[']) {
			servePage()
			await expect(
				capturePreviewTemplate(PAGE, { selectors: { [slot]: selector } }),
			).rejects.toMatchObject({ code: 'SELECTOR_NOT_FOUND', statusCode: 400 })
		}
	})
	it('does not mistake empty paragraph markup for prose', async () => {
		servePage(
			'',
			'<main><h1>Product index</h1><div class="entry-content"><p></p><p></p><p></p></div></main>',
		)
		await expect(capturePreviewTemplate(PAGE)).rejects.toMatchObject({ code: 'NO_ARTICLE_FOUND' })
	})
	it('accepts three non-empty paragraphs even when they total fewer than 400 characters', async () => {
		servePage(
			'',
			'<article><h1>Brief update</h1><div class="post-body"><p>The first paragraph.</p><p>A second paragraph.</p><p>The final paragraph.</p></div></article>',
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.body.strategy).toBe('semantic')
	})
	it('preserves SSR content in a Next mount and uses a known body hint', async () => {
		servePage('', `<div id="__next">${body}</div><script src="/next.js"></script>`)
		const result = await capturePreviewTemplate(PAGE, {
			hints: {
				bodyText: 'Long article prose with enough words to be a useful paragraph. '.repeat(2),
			},
		})
		expect(result.slots.body.strategy).toBe('record-match')
		expect(result.html).not.toMatch(/<!doctype/i)
		expect(result.html).not.toContain('<script')
	})
	it('uses the redirect final URL for base and every page-relative resource', async () => {
		const response = new Response(
			`<html><body>${body}<img src="photo.jpg" style="background:url(../bg.png)"></body></html>`,
			{ headers: { 'content-type': 'text/html' } },
		)
		Object.defineProperty(response, 'url', { value: 'https://final.example/posts/article/' })
		safeFetch.mockResolvedValue(response)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.finalUrl).toBe('https://final.example/posts/article/')
		expect(result.html).toContain('https://final.example/posts/article/photo.jpg')
		expect(result.html).toContain('https://final.example/posts/bg.png')
	})
	it('decodes a meta-declared legacy charset and emits UTF-8 metadata', async () => {
		const input = `<html><head><meta charset="windows-1252"></head><body>${body.replace('Sample', 'Café')}</body></html>`
		safeFetch.mockResolvedValue(
			new Response(Buffer.from(input, 'latin1'), { headers: { 'content-type': 'text/html' } }),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.html).toContain('Café')
		expect(result.html).toContain('<meta charset="utf-8">')
		expect(result.html).not.toContain('windows-1252')
	})
	it('enforces the serialized UTF-8 template budget', async () => {
		servePage()
		await expect(
			capturePreviewTemplate(PAGE, { limits: { templateBytes: 40 } }),
		).rejects.toMatchObject({ code: 'TOO_LARGE', statusCode: 422 })
	})
	it('bounds import cycles and preserves layer/supports imports with absolute references', async () => {
		safeFetch.mockImplementation(
			async (url) =>
				new Response(
					String(url) === PAGE
						? `<html><head><link rel="stylesheet" href="/main.css"></head><body>${body}</body></html>`
						: '@import "main.css"; @import "other.css" layer(theme); @import "modern.css" supports(display:grid); p{color:red}',
					{ headers: { 'content-type': String(url) === PAGE ? 'text/html' : 'text/css' } },
				),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(safeFetch).toHaveBeenCalledTimes(2)
		expect(result.html).toContain('https://blog.example.com/other.css')
		expect(result.html).toContain('layer(theme)')
		expect(result.html).toContain('supports(display:grid)')
		expect(result.warnings.join(' ')).toMatch(/cycle/i)
	})
	it('wraps imported media, preserves link media and rewrites existing inline CSS URLs', async () => {
		safeFetch.mockImplementation(async (url) => {
			const content =
				String(url) === PAGE
					? `<html><head><style>.inline{background:url(/inline.png)}</style><link rel="stylesheet" href="/main.css" media="screen"></head><body>${body}</body></html>`
					: String(url).endsWith('main.css')
						? '@import "print.css" print;'
						: '.print{background:url(paper.png)}'
			return new Response(content, {
				headers: { 'content-type': String(url) === PAGE ? 'text/html' : 'text/css' },
			})
		})
		const result = await capturePreviewTemplate(PAGE)
		const $ = load(result.html)
		expect($('style[data-innolope-href]').attr('media')).toBe('screen')
		expect($('style').text()).toContain('@media print{')
		expect($('style').text()).toContain('https://blog.example.com/paper.png')
		expect($('style').text()).toContain('https://blog.example.com/inline.png')
	})
	it('uses an Origin header and respects the total font budget with warnings', async () => {
		safeFetch.mockImplementation(async (url) => {
			const content =
				String(url) === PAGE
					? `<html><head><style>@font-face{font-family:A;src:url(/a.woff2)}@font-face{font-family:B;src:url(/b.woff2)}</style></head><body>${body}</body></html>`
					: new Uint8Array(16)
			return new Response(content, {
				headers: { 'content-type': String(url) === PAGE ? 'text/html' : 'font/woff2' },
			})
		})
		const result = await capturePreviewTemplate(PAGE, { limits: { totalFontBytes: 20 } })
		expect(result.stats.inlinedFonts).toBe(1)
		expect(result.warnings.join(' ')).toContain('/b.woff2')
		for (const [, init] of safeFetch.mock.calls.slice(1))
			expect(new Headers(init?.headers).has('origin')).toBe(true)
	})
	it('does not select an og:image deep inside article prose', async () => {
		servePage(
			'<meta property="og:image" content="/inline.jpg">',
			body.replace('</div>', '<figure><img src="/inline.jpg"></figure></div>'),
		)
		expect((await capturePreviewTemplate(PAGE)).slots.image).toBeNull()
	})
	it("finds the og:image cover in the post's own header inside <main>", async () => {
		servePage(
			'<meta property="og:image" content="https://blog.example.com/uploads/cover.png">',
			`<header class="site"><nav><a href="/">Home</a></nav></header><main><header><h1>Cover post</h1><img class="cover-image" src="/uploads/cover.png?resize=1200%2C630" width="1200" height="630"></header>${body.replace('<article><h1>Sample</h1>', '').replace('</article>', '')}</main>`,
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image?.strategy).toBe('semantic')
		expect(result.slots.image?.sample).toContain('/uploads/cover.png')
	})
	it('finds a large hero just above an <article> body', async () => {
		servePage(
			'',
			`<main><div class="hero"><img src="/hero.webp" width="3000" height="1286"></div>${body.replace('<article>', '<article class="prose">').replace('<div class="post-body">', '<div>')}</main>`,
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image?.sample).toContain('/hero.webp')
	})
	it('finds a cover inside the body after its header but before any prose', async () => {
		servePage(
			'',
			body.replace(
				'<div class="post-body">',
				'<div class="post-body"><header><span>Tags</span></header><div class="cover"><img src="/cover.jpg" width="1200" height="675"></div>',
			),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image?.sample).toContain('/cover.jpg')
	})
	it("doesn't count byline paragraphs in the body's own header as prose before the cover", async () => {
		servePage(
			'',
			body.replace(
				'<div class="post-body">',
				'<div class="post-body"><header><p>Ann Author and Bo Writer</p><p>Also available in Deutsch.</p></header><div class="cover"><img src="/cover.jpg" width="1200" height="675"></div>',
			),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image?.sample).toContain('/cover.jpg')
	})
	it.each([
		[
			'declared small, even in a figure',
			'<figure><picture><img src="/me-200px.png" width="100" height="100"></picture></figure>',
		],
		['an avatar', '<figure class="bio-image"><img src="/me.png"></figure>'],
		['a logo', '<div><img class="site-logo" src="/logo.png" width="600" height="300"></div>'],
	])('does not take an image %s as the cover', async (_label, image) => {
		servePage('', body.replace('<div class="post-body">', `${image}<div class="post-body">`))
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image).toBeNull()
	})
	const drawn = (viewBox: string) =>
		`<figure class="il-figure" aria-label="Sample-only drawing"><div class="canvas"><svg viewBox="${viewBox}"><rect width="10" height="10"/></svg></div><figcaption>Sample caption</figcaption></figure>`
	it("turns the sample's inline-drawn cover into the image slot", async () => {
		servePage(
			'',
			body.replace('<div class="post-body">', `${drawn('0 0 1200 460')}<div class="post-body">`),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image).toMatchObject({
			strategy: 'heuristic',
			selector: 'figure.il-figure',
		})
		const $ = load(result.html)
		expect($('svg')).toHaveLength(0)
		expect($('figure.il-figure [data-innolope-slot="image"]').is('img')).toBe(true)
		expect($('figure.il-figure').attr('aria-label')).toBeUndefined()
	})
	it('leaves a small inline icon alone', async () => {
		servePage(
			'',
			body.replace('<div class="post-body">', `${drawn('0 0 24 24')}<div class="post-body">`),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image).toBeNull()
		expect(load(result.html)('svg')).toHaveLength(1)
	})
	it('accepts an image override on a drawn figure or on a wrapper of an <img>', async () => {
		servePage(
			'',
			body.replace('<div class="post-body">', `${drawn('0 0 24 24')}<div class="post-body">`),
		)
		const result = await capturePreviewTemplate(PAGE, { selectors: { image: 'figure.il-figure' } })
		expect(result.slots.image).toMatchObject({ strategy: 'override', selector: 'figure.il-figure' })
		expect(load(result.html)('[data-innolope-slot="image"]').is('img')).toBe(true)
		servePage(
			'',
			body.replace(
				'<div class="post-body">',
				'<div class="cover"><img src="/c.jpg"></div><div class="post-body">',
			),
		)
		const wrapped = await capturePreviewTemplate(PAGE, { selectors: { image: 'div.cover' } })
		expect(wrapped.slots.image?.sample).toContain('/c.jpg')
		servePage(
			'',
			body.replace('<div class="post-body">', '<div class="empty"></div><div class="post-body">'),
		)
		await expect(
			capturePreviewTemplate(PAGE, { selectors: { image: 'div.empty' } }),
		).rejects.toMatchObject({ code: 'SELECTOR_NOT_FOUND' })
	})
	it('selects a hero picture as the first body child and excludes block-code classes', async () => {
		servePage(
			'<meta property="og:image" content="/hero.jpg">',
			body.replace(
				'<div class="post-body">',
				'<div class="post-body"><picture><img src="/hero-1200x600.jpg"></picture><pre><code class="fenced">code</code></pre>',
			),
		)
		const result = await capturePreviewTemplate(PAGE)
		expect(result.slots.image).not.toBeNull()
		expect(result.classMap.code).toBeUndefined()
		expect(result.html).toContain('data-innolope-slot="image"')
		expect(result.html).not.toContain('<pre>')
	})
	it('removes hostile schemes, active embeds and http-equiv policies from chrome', async () => {
		servePage(
			'<meta http-equiv="set-cookie" content="x=y"><meta http-equiv="Content-Security-Policy" content="default-src *"><link rel="manifest" href="/manifest.json">',
			`${body}<a href="java&#x09;script:alert(1)" onclick="x()">bad</a><a href="vbscript:bad">bad</a><img src="data:text/html,bad" srcdoc="bad"><portal src="/portal"></portal><form action="/send"><button formaction="/send">Send</button></form>`,
		)
		const $ = load((await capturePreviewTemplate(PAGE)).html)
		expect(
			$('[onclick],[srcdoc],[action],[formaction],portal,link[rel="manifest"],meta[http-equiv]'),
		).toHaveLength(0)
		expect($('a[href],img[src]')).toHaveLength(0)
	})
})
