import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BrowserRenderError,
	type BrowserRenderFailure,
	type PageRenderer,
	type RenderedPage,
} from './browser-render.js'
import { capturePreviewTemplate, PreviewCaptureError } from './preview-template.js'

/*
 * Spec-only acceptance plan: .claude/specs/browser-render-capture.md.
 * What can go wrong: P1 incorrect fallback eligibility/replays; P2 redirect/base
 * confusion; P3 rejected/blocked/oversized/challenged output; P4 unsafe scripts
 * or lost styles/fonts; P5 render cancellation steals the remaining capture time.
 * Verify each boundary below with fixed local responses, never a live browser.
 * Compatibility: absent/null render preserves the plain path; no migration.
 * Provider concurrency/auth/cost limits belong to browser-render.test.ts.
 */

const validatePublicUrl = vi.hoisted(() => vi.fn(async (_url: string) => null as string | null))
const safeFetch = vi.hoisted(() =>
	vi.fn(
		async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
			new Response('', { status: 404 }),
	),
)
vi.mock('../adapters/connection-guard.js', () => ({ validatePublicUrl, safeFetch }))

const PAGE = 'https://blog.example.com/posts/hello-world'
const PLAIN_FINAL = 'https://blog.example.com/redirected/hello-world'
const BROWSER_FINAL = 'https://rendered.example.com/articles/hello-world'
const HTML = { 'content-type': 'text/html; charset=utf-8' }
const CSS = { 'content-type': 'text/css; charset=utf-8' }
const WARNING =
	"Loaded in a browser because the page's HTML had no article; the layout is what its scripts drew."
const RENDER_FAILED_MESSAGE =
	'The page is built by JavaScript, and loading it in a browser failed. Try again in a minute.'

interface Route {
	status?: number
	body?: string | Uint8Array
	headers?: Record<string, string>
}

/** Exact-URL responses, following the existing preview-template test harness. */
function serve(routes: Record<string, Route>) {
	safeFetch.mockImplementation(async (url) => {
		let finalUrl = String(url)
		let route = routes[finalUrl]
		// safeFetch has fetch's redirect-following semantics; Response.url is
		// the final HTTP URL, not the first URL requested by the caller.
		for (let hop = 0; hop < 5 && route?.status === 302 && route.headers?.location; hop++) {
			finalUrl = new URL(route.headers.location, finalUrl).href
			route = routes[finalUrl]
		}
		if (!route)
			return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
		const response = new Response(route.body ?? '', {
			status: route.status ?? 200,
			headers: route.headers ?? HTML,
		})
		Object.defineProperty(response, 'url', { value: finalUrl })
		return response
	})
}

function page(body: string, head = ''): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hello world – Example Blog</title>${head}</head><body>${body}</body></html>`
}

function paragraphs(n: number): string {
	return Array.from(
		{ length: n },
		(_, i) =>
			`<p>Paragraph ${i + 1} of the sample article. It carries enough words to read like real prose, so a detector treats it as body text rather than as the chrome around the article.</p>`,
	).join('')
}

function article(head = ''): string {
	return page(
		`<header><a href="../about">About us</a><img src="../logo.svg" alt="Example"></header><article><h1 class="post-title">Hello world</h1><div class="post-body render-only">${paragraphs(6)}</div></article><footer>Example footer</footer>`,
		head,
	)
}

const SHELL = page('<div id="root"></div><script type="module" src="/app.js"></script>')
const NO_ARTICLE = page('<main><h1>Our products</h1><ul><li>Widget</li><li>Gadget</li></ul></main>')

function renderer(overrides: Partial<RenderedPage> = {}) {
	return vi.fn<PageRenderer>().mockResolvedValue({
		html: article(),
		finalUrl: null,
		status: 200,
		browserMs: 125,
		...overrides,
	})
}

/** The public contract specifies reason/prototype, but no constructor arguments. */
function browserError(reason: BrowserRenderFailure): BrowserRenderError {
	const error = new Error('Synthetic browser failure')
	Object.setPrototypeOf(error, BrowserRenderError.prototype)
	return Object.assign(error, { reason }) as BrowserRenderError
}

async function captureError(
	options?: Parameters<typeof capturePreviewTemplate>[1],
): Promise<PreviewCaptureError> {
	try {
		await capturePreviewTemplate(PAGE, options)
	} catch (error) {
		expect(error).toBeInstanceOf(PreviewCaptureError)
		return error as PreviewCaptureError
	}
	throw new Error('expected capturePreviewTemplate to throw')
}

beforeEach(() => {
	validatePublicUrl.mockReset()
	validatePublicUrl.mockResolvedValue(null)
	safeFetch.mockReset()
	serve({ [PAGE]: { body: SHELL } })
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe('capturePreviewTemplate: browser fallback eligibility', () => {
	it.each([
		{ label: 'CLIENT_RENDERED shell', plain: SHELL, selectors: undefined },
		{
			label: 'NO_ARTICLE_FOUND page with scripts',
			plain: NO_ARTICLE.replace('</body>', '<script src="/app.js"></script></body>'),
			selectors: undefined,
		},
		{
			label: 'SELECTOR_NOT_FOUND page with scripts',
			plain: article('<script src="/app.js"></script>').replace('render-only', 'plain-only'),
			selectors: { body: '.render-only' },
		},
	])('renders once after a $label', async ({ plain, selectors }) => {
		serve({ [PAGE]: { body: plain } })
		const render = renderer()
		const template = await capturePreviewTemplate(PAGE, { render, selectors })
		expect(render).toHaveBeenCalledExactlyOnceWith(PAGE, expect.any(AbortSignal))
		expect(template.html).toContain('data-innolope-slot="body"')
	})

	it.each([
		'',
		'<script src="/app.js"></script>',
	])('never renders a server-rendered article with scripts %j', async (scripts) => {
		serve({ [PAGE]: { body: article(scripts) } })
		const render = renderer()
		const template = await capturePreviewTemplate(PAGE, { render })
		expect(template.html).toContain('data-innolope-slot="body"')
		expect(template.warnings).not.toContain(WARNING)
		expect(render).not.toHaveBeenCalled()
	})

	it.each([
		{ label: 'NO_ARTICLE_FOUND', plain: NO_ARTICLE, selectors: undefined },
		{ label: 'SELECTOR_NOT_FOUND', plain: article(), selectors: { body: '.absent' } },
	])('keeps $label unchanged on a no-script page', async ({ label, plain, selectors }) => {
		serve({ [PAGE]: { body: plain } })
		const render = renderer()
		const error = await captureError({ render, selectors })
		expect(error.code).toBe(label)
		expect(render).not.toHaveBeenCalled()
	})

	it.each([undefined, null])('preserves CLIENT_RENDERED when render is %s', async (render) => {
		const error = await captureError(render === undefined ? {} : { render })
		expect(error.code).toBe('CLIENT_RENDERED')
		expect(safeFetch).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ label: 'private target', blocked: true, status: 200, code: 'BLOCKED_URL' },
		{ label: 'origin rejection', blocked: false, status: 403, code: 'BLOCKED_BY_SITE' },
		{ label: 'missing origin page', blocked: false, status: 404, code: 'FETCH_FAILED' },
	])('does not render after $label', async ({ blocked, status, code }) => {
		if (blocked) validatePublicUrl.mockResolvedValue('Private/internal addresses are not allowed.')
		serve({ [PAGE]: { status, body: SHELL } })
		const render = renderer()
		const error = await captureError({ render })
		expect(error.code).toBe(code)
		expect(render).not.toHaveBeenCalled()
		if (blocked) expect(safeFetch).not.toHaveBeenCalled()
	})

	it.each([
		'http',
		'meta-refresh',
		'http then meta-refresh',
	])('passes the plain final URL once after %s redirects', async (kind) => {
		const intermediate = 'https://blog.example.com/redirect-hop'
		serve({
			[PAGE]:
				kind === 'meta-refresh'
					? { body: page('', `<meta http-equiv="refresh" content="0;url=${PLAIN_FINAL}">`) }
					: {
							status: 302,
							headers: { location: kind === 'http' ? PLAIN_FINAL : intermediate },
						},
			[intermediate]: {
				body: page('', `<meta http-equiv="refresh" content="0;url=${PLAIN_FINAL}">`),
			},
			[PLAIN_FINAL]: { body: SHELL },
		})
		const render = renderer({ finalUrl: BROWSER_FINAL })
		const template = await capturePreviewTemplate(PAGE, { render })
		expect(render).toHaveBeenCalledExactlyOnceWith(PLAIN_FINAL, expect.any(AbortSignal))
		expect(template.sourceUrl).toBe(PAGE)
		expect(template.finalUrl).toBe(BROWSER_FINAL)
	})
})

describe('capturePreviewTemplate: browser fallback failures', () => {
	it.each([
		{ label: 'busy', rejection: browserError('busy') },
		{ label: 'unavailable', rejection: browserError('unavailable') },
		{ label: 'failed', rejection: browserError('failed') },
		{ label: 'network error', rejection: new Error('Network unavailable') },
		{ label: 'abort', rejection: new DOMException('Aborted', 'AbortError') },
		{ label: 'non-Error rejection', rejection: 'unexpected rejection' },
	])('maps $label to RENDER_FAILED with HTTP 502', async ({ rejection }) => {
		const render = renderer().mockRejectedValue(rejection)
		const error = await captureError({ render })
		expect(error.code).toBe('RENDER_FAILED')
		expect(error.statusCode).toBe(502)
		expect(error.message).toBe(RENDER_FAILED_MESSAGE)
		expect(render).toHaveBeenCalledTimes(1)
		expect(safeFetch).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ status: 401, code: 'BLOCKED_BY_SITE' },
		{ status: 403, code: 'BLOCKED_BY_SITE' },
		{ status: 429, code: 'BLOCKED_BY_SITE' },
		{ status: 400, code: 'FETCH_FAILED' },
		{ status: 404, code: 'FETCH_FAILED' },
		{ status: 500, code: 'FETCH_FAILED' },
		{ status: 503, code: 'FETCH_FAILED' },
	])('maps rendered origin status $status to $code', async ({ status, code }) => {
		const render = renderer({ status })
		expect((await captureError({ render })).code).toBe(code)
		expect(render).toHaveBeenCalledTimes(1)
		expect(safeFetch).toHaveBeenCalledTimes(1)
	})

	it('rejects rendered HTML over pageBytes as TOO_LARGE, counting UTF-8 bytes', async () => {
		const html = page(`<div>${'🦊'.repeat(125)}</div>`)
		expect(html.length).toBeLessThan(512)
		expect(Buffer.byteLength(html)).toBeGreaterThan(512)
		const render = renderer({ html })
		expect((await captureError({ render, limits: { pageBytes: 512 } })).code).toBe('TOO_LARGE')
		expect(render).toHaveBeenCalledTimes(1)
	})

	it.each([
		page('<div>Checking your browser</div>').replace(
			/<title>.*?<\/title>/,
			'<title>Just a moment...</title>',
		),
		page('<div>Checking your browser</div>', '<script>window._cf_chl_opt = {};</script>'),
	])('rejects a rendered challenge as BLOCKED_BY_SITE: %s', async (html) => {
		const render = renderer({ html })
		expect((await captureError({ render })).code).toBe('BLOCKED_BY_SITE')
		expect(render).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ label: 'CLIENT_RENDERED', html: SHELL },
		{ label: 'NO_ARTICLE_FOUND', html: NO_ARTICLE },
	])('maps rendered $label to NO_ARTICLE_FOUND without another render', async ({ html }) => {
		const render = renderer({ html })
		expect((await captureError({ render })).code).toBe('NO_ARTICLE_FOUND')
		expect(render).toHaveBeenCalledTimes(1)
	})

	it('keeps SELECTOR_NOT_FOUND when the rendered page still misses the override', async () => {
		const render = renderer()
		const error = await captureError({ render, selectors: { body: '.missing-after-render' } })
		expect(error.code).toBe('SELECTOR_NOT_FOUND')
		expect(render).toHaveBeenCalledTimes(1)
	})
})

describe('capturePreviewTemplate: rendered template output', () => {
	it('finds title, body and image slots in the rendered article', async () => {
		const html = page(
			`<article class="post type-post"><header><h1 class="entry-title">Hello world</h1></header><div class="post-thumbnail"><img class="wp-post-image" src="/hero.jpg" alt="Hero"></div><div class="entry-content">${paragraphs(6)}</div></article>`,
			'<meta property="og:image" content="https://blog.example.com/hero.jpg">',
		)
		const template = await capturePreviewTemplate(PAGE, { render: renderer({ html }) })
		expect(template.html).toMatch(/<h1\b[^>]*data-innolope-slot="title"/i)
		expect(template.html).toMatch(/<div\b[^>]*data-innolope-slot="body"/i)
		expect(template.html).toMatch(/<img\b[^>]*data-innolope-slot="image"/i)
		expect(template.slots.title).not.toBeNull()
		expect(template.slots.body.selector).toBeTruthy()
		expect(template.slots.image).not.toBeNull()
		expect(template.html).not.toContain('Paragraph 3 of the sample article')
	})

	it('removes page scripts and injected scripts from the rendered template', async () => {
		const html = article(
			'<script src="/app.js"></script><script>/* CSSOM serializer */setInterval(()=>{},250)</script><script type="application/ld+json">{"@type":"Article"}</script>',
		).replace('</body>', '<script>window.pageScript = true</script></body>')
		const template = await capturePreviewTemplate(PAGE, { render: renderer({ html }) })
		expect(template.html).not.toMatch(/<script\b/i)
		expect(template.html).not.toContain('CSSOM serializer')
		expect(template.html).not.toContain('pageScript')
	})

	it.each([
		BROWSER_FINAL,
		null,
	])('pins the base and relative URLs to rendered finalUrl %s, preserving sourceUrl', async (finalUrl) => {
		serve({
			[PAGE]: { status: 302, headers: { location: PLAIN_FINAL } },
			[PLAIN_FINAL]: { body: SHELL },
		})
		const render = renderer({
			finalUrl,
			html: article('<base href="https://untrusted.example/">'),
		})
		const template = await capturePreviewTemplate(PAGE, { render })
		const expectedFinal = finalUrl ?? PLAIN_FINAL
		expect(template.sourceUrl).toBe(PAGE)
		expect(template.finalUrl).toBe(expectedFinal)
		const bases = template.html.match(/<base\b[^>]*>/gi) ?? []
		expect(bases).toHaveLength(1)
		expect(bases[0]).toContain(`href="${expectedFinal}"`)
		expect(template.html).toContain(`href="${new URL('../about', expectedFinal).href}"`)
		expect(template.html).toContain(`src="${new URL('../logo.svg', expectedFinal).href}"`)
		expect(template.html).not.toContain('untrusted.example')
	})

	it('includes the exact browser fallback warning', async () => {
		const template = await capturePreviewTemplate(PAGE, { render: renderer() })
		expect(template.warnings).toContain(WARNING)
	})

	it('inlines rendered stylesheets and fonts through guarded safeFetch', async () => {
		const stylesheet = 'https://rendered.example.com/css/main.css'
		const font = 'https://rendered.example.com/fonts/brand.woff2'
		const fontBytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4])
		serve({
			[PAGE]: { body: SHELL },
			[stylesheet]: {
				body: '@font-face{font-family:Brand;src:url(../fonts/brand.woff2)}.rendered{color:#123456;background:url(../img/bg.png)}',
				headers: CSS,
			},
			[font]: { body: fontBytes, headers: { 'content-type': 'font/woff2' } },
		})
		const render = renderer({
			finalUrl: BROWSER_FINAL,
			html: article('<link rel="stylesheet" href="/css/main.css">'),
		})
		const template = await capturePreviewTemplate(PAGE, { render })
		for (const url of [stylesheet, font]) {
			expect(safeFetch).toHaveBeenCalledWith(
				url,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		}
		expect(template.html).not.toMatch(/<link\b[^>]*rel="stylesheet"/i)
		expect(template.html).toContain(`data-innolope-href="${stylesheet}"`)
		expect(template.html).toContain('color:#123456')
		expect(template.html).toContain('https://rendered.example.com/img/bg.png')
		expect(template.html).toContain(
			`data:font/woff2;base64,${Buffer.from(fontBytes).toString('base64')}`,
		)
		expect(template.stats.stylesheets).toBe(1)
		expect(template.stats.inlinedFonts).toBe(1)
	})
})

describe('capturePreviewTemplate: browser deadlines', () => {
	it.each([
		{ label: 'configured', renderTimeoutMs: 30 },
		{ label: 'default', renderTimeoutMs: undefined },
	])('aborts the render within the $label render timeout', async ({ renderTimeoutMs }) => {
		const started = Promise.withResolvers<AbortSignal>()
		const render = vi.fn<PageRenderer>().mockImplementation(async (_url, signal) => {
			started.resolve(signal)
			return new Promise((_resolve, reject) => {
				if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
				else
					signal.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					)
			})
		})
		const result = captureError({
			render,
			limits: renderTimeoutMs === undefined ? {} : { renderTimeoutMs },
		})
		const signal = await started.promise
		expect(signal).toBeInstanceOf(AbortSignal)
		// Native AbortSignal.timeout uses real timers, independently of Vitest's
		// fake clock. Exercise that public signal with a bounded real wait.
		await new Promise((resolve) => setTimeout(resolve, (renderTimeoutMs ?? 20_000) + 50))
		expect(signal.aborted).toBe(true)
		const error = await result
		expect(error.code).toBe('RENDER_FAILED')
		expect(error.statusCode).toBe(502)
		expect(render).toHaveBeenCalledTimes(1)
	}, 25_000)

	it('extends the capture deadline so slow rendering leaves time for stylesheet and font inlining', async () => {
		// Move only the injected wall clock: no real waiting or provider work.
		// A plain-path control establishes that the chosen elapsed time really
		// exhausts the ordinary inlining budget, avoiding a vacuous success.
		const initialNow = Date.now()
		let now = initialNow
		vi.spyOn(Date, 'now').mockImplementation(() => now)
		const stylesheet = 'https://blog.example.com/css/slow-render.css'
		const font = 'https://blog.example.com/fonts/after-render.woff2'
		const assets: Record<string, Route> = {
			[stylesheet]: {
				body: '@font-face{font-family:AfterRender;src:url(/fonts/after-render.woff2)}body{color:#654321}',
				headers: CSS,
			},
			[font]: {
				body: new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
				headers: { 'content-type': 'font/woff2' },
			},
		}
		const renderedHtml = article('<link rel="stylesheet" href="/css/slow-render.css">')
		serve({ [PAGE]: { body: renderedHtml }, ...assets })
		const servePlain = safeFetch.getMockImplementation()
		if (!servePlain) throw new Error('missing fixture server')
		safeFetch.mockImplementation(async (url, init) => {
			const response = await servePlain(url, init)
			if (String(url) === PAGE) now += 59_000
			return response
		})
		const plain = await capturePreviewTemplate(PAGE)
		expect(plain.stats.stylesheets).toBe(0)
		expect(plain.stats.inlinedFonts).toBe(0)

		now = initialNow
		safeFetch.mockClear()
		serve({ [PAGE]: { body: SHELL }, ...assets })
		const render = renderer().mockImplementation(async () => {
			now += 59_000
			return {
				html: renderedHtml,
				finalUrl: null,
				status: 200,
				browserMs: 59_000,
			}
		})
		const template = await capturePreviewTemplate(PAGE, {
			render,
			limits: { renderTimeoutMs: 60_000 },
		})
		expect(template.html).toContain('color:#654321')
		expect(template.stats.stylesheets).toBe(1)
		expect(template.stats.inlinedFonts).toBe(1)
		expect(safeFetch.mock.calls.map(([url]) => String(url))).toEqual([PAGE, stylesheet, font])
	})
})
