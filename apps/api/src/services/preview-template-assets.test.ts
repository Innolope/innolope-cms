import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePreviewTemplate } from './preview-template.js'

const validatePublicUrl = vi.hoisted(() => vi.fn(async (_url: string) => null as string | null))
const safeFetch = vi.hoisted(() =>
	vi.fn(
		async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
			new Response('', { status: 404 }),
	),
)
const directFetch = vi.hoisted(() => ({
	run: undefined as ((url: string | URL, init?: RequestInit) => Promise<Response>) | undefined,
}))
vi.mock('../adapters/connection-guard.js', () => ({
	validatePublicUrl,
	safeFetch: (url: string | URL, init?: RequestInit) => (directFetch.run ?? safeFetch)(url, init),
}))

const PAGE = 'https://blog.example.com/posts/article'
const ORIGIN = 'https://blog.example.com'
const selectors = { title: 'h1', body: '.post-body' }
function page(head: string) {
	return `<html><head>${head}</head><body><article><h1>Sample article</h1><div class="post-body">${'<p>A substantial paragraph of article prose with enough words to identify the article content.</p>'.repeat(5)}</div></article></body></html>`
}
function response(body: string | Uint8Array, type = 'text/css') {
	return new Response(body, { headers: { 'content-type': type } })
}
function face(name: string, range?: string, url = `/fonts/${name}.woff2`) {
	return `@font-face{font-family:${name};src:url(${url});${range === undefined ? '' : `unicode-range:${range};`}}`
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
	validatePublicUrl.mockReset().mockResolvedValue(null)
	safeFetch.mockReset()
	directFetch.run = undefined
})

describe('preview asset acceptance: R1/R2/R3/R8 deadline and rejection cleanup', () => {
	it('observes a fetch rejection even when its signal aborts synchronously before bounded receives it', async () => {
		const unhandled: unknown[] = []
		const listener = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', listener)
		const originalAny = AbortSignal.any.bind(AbortSignal)
		const controllers = new WeakMap<AbortSignal, AbortController>()
		const aborted: boolean[] = []
		const any = vi.spyOn(AbortSignal, 'any').mockImplementation((signals) => {
			const controller = new AbortController()
			const signal = originalAny([...signals, controller.signal])
			controllers.set(signal, controller)
			return signal
		})
		// vi.fn observes returned rejections for settledResults, masking this regression.
		directFetch.run = (url, init) => {
			if (String(url) === PAGE)
				return Promise.resolve(
					response(page('<link rel="stylesheet" href="/abort.css">'), 'text/html'),
				)
			if (init?.signal)
				controllers.get(init.signal)?.abort(new DOMException('Immediate timeout', 'TimeoutError'))
			aborted.push(init?.signal?.aborted ?? false)
			return Promise.reject(new DOMException('Rejected fetch input', 'TimeoutError'))
		}
		try {
			const result = await capturePreviewTemplate(PAGE, { selectors })
			expect(result.html).toContain(`${ORIGIN}/abort.css`)
			expect(aborted).toEqual([true])
			await tick()
			await tick()
			expect(unhandled).toEqual([])
		} finally {
			any.mockRestore()
			directFetch.run = undefined
			process.removeListener('unhandledRejection', listener)
		}
	})
	it('keeps a stalled page fatal with FETCH_FAILED', async () => {
		const cancel = vi.fn()
		safeFetch.mockResolvedValue(
			new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } }),
		)
		await expect(
			capturePreviewTemplate(PAGE, { limits: { totalTimeoutMs: 30 } }),
		).rejects.toMatchObject({ code: 'FETCH_FAILED' })
		expect(cancel).toHaveBeenCalledOnce()
		expect(safeFetch).toHaveBeenCalledOnce()
	})

	it('returns usable HTML after an asset deadline, starts no doomed requests and observes rejected cleanup promises', async () => {
		const unhandled: unknown[] = []
		const listener = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', listener)
		let expired = false
		const afterExpiry: string[] = []
		const links = Array.from(
			{ length: 12 },
			(_, i) => `<link rel="stylesheet" href="/slow-${i}.css">`,
		).join('')
		safeFetch.mockImplementation(async (url, init) => {
			if (String(url) === PAGE) return response(page(links), 'text/html')
			if (expired || init?.signal?.aborted) afterExpiry.push(String(url))
			init?.signal?.addEventListener(
				'abort',
				() => {
					expired = true
				},
				{ once: true },
			)
			return new Response(
				new ReadableStream({
					cancel() {
						return Promise.reject(new Error('deliberate cancelled asset cleanup rejection'))
					},
				}),
				{ headers: { 'content-type': 'text/css' } },
			)
		})
		try {
			const result = await capturePreviewTemplate(PAGE, {
				selectors,
				limits: { totalTimeoutMs: 40, requestTimeoutMs: 500 },
			})
			expect(result.html).toContain('data-innolope-slot="body"')
			for (let i = 0; i < 12; i++) expect(result.html).toContain(`${ORIGIN}/slow-${i}.css`)
			expect(
				result.warnings.filter((warning) => /time|deadline|budget/i.test(warning)),
			).toHaveLength(1)
			expect(afterExpiry).toEqual([])
			await tick()
			await tick()
			await tick()
			expect(unhandled).toEqual([])
		} finally {
			process.removeListener('unhandledRejection', listener)
		}
	})

	it('retains absolute imports and font references when the asset deadline expires', async () => {
		safeFetch.mockImplementation(async (url) => {
			if (String(url) === PAGE)
				return response(page(`<style>@import "/slow.css";${face('later')}</style>`), 'text/html')
			return new Response(new ReadableStream({ cancel() {} }), {
				headers: { 'content-type': 'text/css' },
			})
		})
		const result = await capturePreviewTemplate(PAGE, {
			selectors,
			limits: { totalTimeoutMs: 40, requestTimeoutMs: 500 },
		})
		expect(result.html).toContain(`${ORIGIN}/slow.css`)
		expect(result.html).toContain(`${ORIGIN}/fonts/later.woff2`)
		expect(result.warnings.filter((warning) => /time|deadline|budget/i.test(warning))).toHaveLength(
			1,
		)
	})
})

describe('preview asset acceptance: R4 bounded parallel work and stable order', () => {
	it('shares at most six network slots across sheets, imports and fonts without recursive deadlock', async () => {
		let active = 0
		let peak = 0
		const pending = new Set<() => void>()
		const fetched: string[] = []
		const links = Array.from(
			{ length: 8 },
			(_, i) => `<link rel="stylesheet" href="/sheet-${i}.css">`,
		).join('')
		safeFetch.mockImplementation(async (url) => {
			const address = String(url)
			if (address === PAGE) return response(page(links), 'text/html')
			fetched.push(address)
			active++
			peak = Math.max(peak, active)
			await new Promise<void>((resolve) => {
				const release = () => {
					clearTimeout(timer)
					pending.delete(release)
					resolve()
				}
				const timer = setTimeout(release, address.endsWith('sheet-0.css') ? 30 : 5)
				pending.add(release)
			})
			active--
			const index = /-(\d+)/.exec(address)?.[1] ?? '0'
			if (address.endsWith('.woff2')) return response(new Uint8Array(8), 'font/woff2')
			if (address.includes('/nested-'))
				return response(`.nested-${index}{color:green}${face(`font-${index}`)}`)
			return response(`@import "nested-${index}.css";.sheet-${index}{color:red}`)
		})
		try {
			const result = await capturePreviewTemplate(PAGE, {
				selectors,
				limits: { maxStylesheets: 32, totalTimeoutMs: 1000 },
			})
			expect(peak).toBeGreaterThan(1)
			expect(peak).toBeLessThanOrEqual(6)
			expect(fetched.filter((url) => url.endsWith('.css'))).toHaveLength(16)
			expect(fetched.filter((url) => url.endsWith('.woff2'))).toHaveLength(8)
			expect(result.stats.inlinedFonts).toBe(8)
			for (let i = 0; i < 8; i++) {
				expect(result.html).toContain(`.nested-${i}`)
				if (i > 0)
					expect(result.html.indexOf(`.sheet-${i - 1}`)).toBeLessThan(
						result.html.indexOf(`.sheet-${i}`),
					)
			}
			expect(result.warnings).toEqual([])
		} finally {
			for (const release of pending) release()
		}
	})
})

describe('preview asset acceptance: R5/R6 shared budgets and Unicode subsets', () => {
	it.each([
		['absent', undefined, true],
		['Latin point', 'U+0041', true],
		['Cyrillic interval', 'U+0400-052F', true],
		['boundary point', 'U+052F', true],
		['outside boundary', 'U+0530', false],
		['Latin wildcard', 'U+00??', true],
		['CJK wildcard', 'U+4???', false],
		['CJK interval', 'U+4E00-9FFF', false],
		['mixed list', 'U+4E00-9FFF, U+0041', true],
		[
			'CJK slice carrying combining accents',
			'U+304,U+307,U+1E3E-1E3F,U+1EA0-1EF9,U+2002-2003',
			false,
		],
		['combining marks only', 'U+0300-036F', false],
		['Vietnamese', 'U+0102-0103, U+0110-0111, U+1EA0-1EF9', true],
		['malformed range', 'not-a-range', true],
	] as const)('fetches only eligible font subset: %s', async (_name, range, eligible) => {
		safeFetch.mockImplementation(async (url) =>
			String(url) === PAGE
				? response(page(`<style>${face('subset', range)}</style>`), 'text/html')
				: response(new Uint8Array(8), 'font/woff2'),
		)
		const result = await capturePreviewTemplate(PAGE, { selectors })
		expect(safeFetch.mock.calls.filter(([url]) => String(url).endsWith('.woff2'))).toHaveLength(
			eligible ? 1 : 0,
		)
		expect(result.stats.inlinedFonts).toBe(eligible ? 1 : 0)
		expect(result.warnings).toEqual([])
		if (!eligible) expect(result.html).toContain(`${ORIGIN}/fonts/subset.woff2`)
	})

	it('skips all 180 CJK subsets without requests, warnings or font counts', async () => {
		const css = Array.from({ length: 180 }, (_, i) => face(`cjk-${i}`, 'U+4E00-9FFF')).join('')
		safeFetch.mockResolvedValue(response(page(`<style>${css}</style>`), 'text/html'))
		const result = await capturePreviewTemplate(PAGE, { selectors })
		expect(safeFetch).toHaveBeenCalledOnce()
		expect(result.stats.inlinedFonts).toBe(0)
		expect(result.warnings).toEqual([])
		expect(result.html).toContain(`${ORIGIN}/fonts/cjk-179.woff2`)
	})

	it('stops future font fetches when the shared byte budget is exhausted', async () => {
		const css = Array.from({ length: 12 }, (_, i) => face(`budget-${i}`)).join('')
		safeFetch.mockImplementation(async (url) =>
			String(url) === PAGE
				? response(page(`<style>${css}</style>`), 'text/html')
				: response(new Uint8Array(16), 'font/woff2'),
		)
		const result = await capturePreviewTemplate(PAGE, {
			selectors,
			limits: { fontBytes: 16, totalFontBytes: 16 },
		})
		expect(safeFetch.mock.calls.filter(([url]) => String(url).endsWith('.woff2'))).toHaveLength(1)
		expect(result.stats.inlinedFonts).toBe(1)
		expect(result.warnings.join(' ')).toMatch(/font|budget/i)
		expect(result.html).toContain(`${ORIGIN}/fonts/budget-11.woff2`)
	})

	it('fetches a shared font URL once across independent stylesheets', async () => {
		safeFetch.mockImplementation(async (url) => {
			if (String(url) === PAGE)
				return response(
					page('<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">'),
					'text/html',
				)
			if (String(url).endsWith('.css')) return response(face('Shared', undefined, '/shared.woff2'))
			return response(new Uint8Array(8), 'font/woff2')
		})
		const result = await capturePreviewTemplate(PAGE, { selectors })
		expect(
			safeFetch.mock.calls.filter(([url]) => String(url).endsWith('/shared.woff2')),
		).toHaveLength(1)
		expect(result.html).not.toContain(`${ORIGIN}/shared.woff2`)
		expect(result.warnings).toEqual([])
	})
})
