import { type CheerioAPI, load } from 'cheerio/slim'
import { parse } from 'parse5'
import { adapter } from 'parse5-htmlparser2-tree-adapter'
import valueParser, { type FunctionNode } from 'postcss-value-parser'
import { safeFetch, validatePublicUrl } from '../adapters/connection-guard.js'
import type { PageRenderer, RenderedPage } from './browser-render.js'

export type PreviewCaptureErrorCode =
	| 'INVALID_URL'
	| 'BLOCKED_URL'
	| 'FETCH_FAILED'
	| 'BLOCKED_BY_SITE'
	| 'NOT_HTML'
	| 'TOO_LARGE'
	| 'CLIENT_RENDERED'
	| 'NO_ARTICLE_FOUND'
	| 'SELECTOR_NOT_FOUND'
	| 'RENDER_FAILED'

const messages: Record<PreviewCaptureErrorCode, string> = {
	INVALID_URL: 'Paste an absolute http:// or https:// article URL.',
	BLOCKED_URL: 'This URL points to a private or internal address. Use a public article URL.',
	FETCH_FAILED: 'The page could not be downloaded. Check the URL and try again.',
	BLOCKED_BY_SITE:
		'The site blocked the download. Try another published article or allow access to the site.',
	NOT_HTML: 'This URL does not return an HTML page. Paste the published article URL.',
	TOO_LARGE: 'The page or template exceeds the preview size limit. Try a smaller article page.',
	CLIENT_RENDERED:
		'The page is built by JavaScript in the browser, so its HTML has no article to copy. Try a server-rendered article URL.',
	NO_ARTICLE_FOUND: 'No article prose was found. Try another article or specify a body selector.',
	SELECTOR_NOT_FOUND:
		'A supplied CSS selector is invalid or matches no usable element. Check the selector and try again.',
	RENDER_FAILED:
		'The page is built by JavaScript, and loading it in a browser failed. Try again in a minute.',
}

export class PreviewCaptureError extends Error {
	readonly statusCode: number
	/** `cause`: what went wrong underneath, for the server log only. */
	constructor(
		readonly code: PreviewCaptureErrorCode,
		options?: { cause?: unknown },
	) {
		super(messages[code], options)
		this.name = 'PreviewCaptureError'
		this.statusCode = ['INVALID_URL', 'BLOCKED_URL', 'SELECTOR_NOT_FOUND'].includes(code)
			? 400
			: ['FETCH_FAILED', 'BLOCKED_BY_SITE', 'RENDER_FAILED'].includes(code)
				? 502
				: 422
	}
}

export interface PreviewSelectors {
	title?: string
	body?: string
	image?: string
}
export interface PreviewSlotInfo {
	selector: string
	strategy: 'override' | 'record-match' | 'semantic' | 'heuristic'
	sample?: string
}
export interface PreviewLimits {
	pageBytes: number
	stylesheetBytes: number
	totalCssBytes: number
	maxStylesheets: number
	maxImportDepth: number
	fontBytes: number
	totalFontBytes: number
	templateBytes: number
	requestTimeoutMs: number
	totalTimeoutMs: number
	/** Extra time a capture gets when it has to load the page in a browser. */
	renderTimeoutMs: number
}
export const PREVIEW_LIMITS: PreviewLimits = {
	pageBytes: 5_000_000,
	stylesheetBytes: 2_000_000,
	totalCssBytes: 6_000_000,
	maxStylesheets: 30,
	maxImportDepth: 3,
	fontBytes: 1_500_000,
	totalFontBytes: 4_000_000,
	templateBytes: 10_000_000,
	requestTimeoutMs: 10_000,
	totalTimeoutMs: 30_000,
	renderTimeoutMs: 20_000,
}
export interface PreviewTemplate {
	sourceUrl: string
	finalUrl: string
	html: string
	slots: { title: PreviewSlotInfo | null; body: PreviewSlotInfo; image: PreviewSlotInfo | null }
	classMap: Record<string, string>
	warnings: string[]
	stats: { bytes: number; stylesheets: number; inlinedFonts: number }
	capturedAt: string
}

/**
 * Parse HTML the way a browser does. `cheerio/slim` instead of `cheerio`: the
 * full entry imports undici 7 at load time, which installs its own Agent as the
 * process-wide fetch dispatcher, and Node's built-in fetch (undici 8) then
 * returns every response in the API without headers. parse5 keeps the parse
 * spec-exact, so what the sanitizer sees is what the preview frame will see.
 */
export function loadHtml(html: string): CheerioAPI {
	return load(parse(html, { treeAdapter: adapter }), {
		xml: { xmlMode: false, encodeEntities: 'utf8' },
	})
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()
const badUrl = (url: string) =>
	/^(?:javascript:|vbscript:|data:text\/html)/i.test(
		Array.from(url)
			.filter((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127 && !/\s/.test(char))
			.join(''),
	)
function absolute(url: string, base: string): string {
	if (badUrl(url)) return ''
	try {
		return new URL(url, base).href
	} catch {
		return ''
	}
}
function rewriteSrcset(value: string, base: string): string {
	const candidates: string[] = []
	let index = 0
	while (index < value.length) {
		while (/[\s,]/.test(value[index] ?? '') && index < value.length) index++
		const start = index
		while (index < value.length && !/\s/.test(value[index])) index++
		const token = value.slice(start, index)
		if (!token) break
		const ref = absolute(token.replace(/,+$/, ''), base)
		if (token.endsWith(',')) {
			if (ref) candidates.push(ref)
			continue
		}
		const descriptorStart = index
		let depth = 0
		while (index < value.length) {
			if (value[index] === '(') depth++
			if (value[index] === ')') depth--
			if (value[index] === ',' && depth <= 0) break
			index++
		}
		const descriptor = value.slice(descriptorStart, index).trim()
		if (ref) candidates.push(`${ref}${descriptor ? ` ${descriptor}` : ''}`)
		index++
	}
	return candidates.join(', ')
}
const escapeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style')
function rewriteCssUrls(css: string, base: string): string {
	const parsed = valueParser(css)
	parsed.walk((node) => {
		if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return
		const value =
			node.nodes.length === 1 && node.nodes[0].type === 'string'
				? node.nodes[0].value
				: valueParser.stringify(node.nodes).trim()
		const decoded = value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_match, hex, char) =>
			hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char,
		)
		// `url(#gradient)` names an element of the page itself whatever the base URL;
		// resolving it would point SVG fills, clips and masks at another document.
		if (decoded.trim().startsWith('#')) return false
		node.nodes = [
			{
				type: 'string',
				value: absolute(decoded, base).replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
				quote: '"',
				sourceIndex: 0,
				sourceEndIndex: 0,
			},
		]
		return false
	})
	return parsed.toString()
}

function cssMatches(css: string, pattern: RegExp): RegExpMatchArray[] {
	const literals: Array<{ start: number; end: number }> = []
	valueParser(css).walk((node) => {
		if (node.type === 'string' || node.type === 'comment')
			literals.push({ start: node.sourceIndex, end: node.sourceEndIndex })
	})
	let index = 0
	return Array.from(css.matchAll(pattern)).filter((match) => {
		while (literals[index] && literals[index].end <= (match.index ?? 0)) index++
		return !literals[index] || literals[index].start > (match.index ?? 0)
	})
}
function decode(bytes: Uint8Array, contentType: string, html = false): string {
	const header = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
	const meta = html
		? /<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(
				Buffer.from(bytes.subarray(0, 4096)).toString('latin1'),
			)?.[1]
		: undefined
	try {
		return new TextDecoder(header ?? meta ?? 'utf-8').decode(bytes)
	} catch {
		return new TextDecoder().decode(bytes)
	}
}

/**
 * Where an instant `<meta http-equiv="refresh">` sends a page that has no content of
 * its own. Read from the source rather than the DOM because generators put the tag in
 * `<noscript>`, which parses as text. A delayed refresh (news sites reloading the
 * page) or a page with real content is not a redirect.
 */
function refreshTarget(source: string, base: string): string | null {
	const tag = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b[^>]*>/i.exec(source)?.[0]
	const content = tag ? (loadHtml(tag)('meta').attr('content') ?? '') : ''
	const match = /^\s*(\d+(?:\.\d*)?)\s*[;,]\s*(?:url\s*=\s*)?(['"]?)(.+?)\2\s*$/i.exec(content)
	if (!match || Number(match[1]) > 5) return null
	const page = loadHtml(source)
	page('script,style,noscript,template').remove()
	if (normalize(page('body').text()).length >= 400) return null
	const target = absolute(match[3], base)
	return /^https?:/i.test(target) ? target : null
}

function usesPreviewScripts(face: string): boolean {
	const declaration = cssMatches(face, /\bunicode-range\s*:\s*([^;}]+)/gi).at(-1)
	if (!declaration) return true
	const ranges = declaration[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',')
	return ranges.some((range) => {
		const value = range.trim()
		const interval = /^u\+([\da-f]{1,6})(?:-([\da-f]{1,6}))?$/i.exec(value)
		const wildcard = /^u\+([\da-f]*)(\?+)$/i.exec(value)
		let start: number
		let end: number
		if (interval) {
			start = Number.parseInt(interval[1], 16)
			end = Number.parseInt(interval[2] ?? interval[1], 16)
		} else if (wildcard && wildcard[1].length + wildcard[2].length <= 6) {
			start = Number.parseInt(wildcard[1] + '0'.repeat(wildcard[2].length), 16)
			end = Number.parseInt(wildcard[1] + 'f'.repeat(wildcard[2].length), 16)
		} else return true
		return (
			end < start ||
			end > 0x10ffff ||
			PREVIEW_LETTERS.some(([low, high]) => start <= high && end >= low)
		)
	})
}

/**
 * Digits and letters of the scripts previews are written in: Latin, Greek, Cyrillic.
 * Subsets covering none of them are left for the font host to serve on demand. Letters,
 * not just low code points: CJK slices carry a few combining accents (`U+304,U+307`)
 * and would otherwise inline half a megabyte each.
 */
const PREVIEW_LETTERS: Array<[number, number]> = [
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x61, 0x7a],
	[0xc0, 0x24f],
	[0x370, 0x3ff],
	[0x400, 0x52f],
]

/** Plain-capture failures that loading the page in a browser can fix. */
const RENDERABLE = new Set<PreviewCaptureErrorCode>([
	'CLIENT_RENDERED',
	'NO_ARTICLE_FOUND',
	'SELECTOR_NOT_FOUND',
])

export async function capturePreviewTemplate(
	url: string,
	options: {
		selectors?: PreviewSelectors
		hints?: { title?: string; bodyText?: string }
		limits?: Partial<PreviewLimits>
		/**
		 * Loads the page in a browser when its served HTML has no article because
		 * scripts build it (`browserRendererFromEnv`). Without one those pages fail
		 * with CLIENT_RENDERED.
		 */
		render?: PageRenderer | null
	} = {},
): Promise<PreviewTemplate> {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new PreviewCaptureError('INVALID_URL')
	}
	if (!['http:', 'https:'].includes(parsed.protocol)) throw new PreviewCaptureError('INVALID_URL')
	const limits = { ...PREVIEW_LIMITS, ...options.limits }
	for (const value of Object.values(limits)) {
		if (!Number.isFinite(value) || value < 0) throw new PreviewCaptureError('INVALID_URL')
	}
	// One deadline for the whole capture, pushed back once if the page has to be
	// loaded in a browser so stylesheets and fonts still get their usual time.
	let expiresAt = Date.now() + limits.totalTimeoutMs
	const deadlineController = new AbortController()
	const deadline = deadlineController.signal
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined
	const armDeadline = () => {
		clearTimeout(deadlineTimer)
		deadlineTimer = setTimeout(
			() => deadlineController.abort(),
			Math.max(1, expiresAt - Date.now()),
		)
		deadlineTimer.unref?.()
	}
	armDeadline()
	async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const cleanup = () => signal.removeEventListener('abort', abort)
			const abort = () => {
				cleanup()
				reject(new PreviewCaptureError('FETCH_FAILED'))
			}
			// Observe the input even if the signal was already aborted when it arrived.
			void promise
				.then(
					(value) => {
						cleanup()
						resolve(value)
					},
					(error) => {
						cleanup()
						reject(error)
					},
				)
				.catch(reject)
			signal.addEventListener('abort', abort, { once: true })
			if (signal.aborted) abort()
		})
	}
	try {
		if (await bounded(validatePublicUrl(url), deadline))
			throw new PreviewCaptureError('BLOCKED_URL')
	} catch (error) {
		if (error instanceof PreviewCaptureError) throw error
		throw new PreviewCaptureError('FETCH_FAILED')
	}
	const warnings = new Set<string>()
	const stats = { bytes: 0, stylesheets: 0, inlinedFonts: 0 }
	let cssBytes = 0
	let fontBytes = 0
	let pageDownloaded = false
	let assetTimeExhausted = false
	const assetAbort = new AbortController()
	function assetsExpired() {
		if (assetTimeExhausted || deadline.aborted || Date.now() >= expiresAt) {
			assetTimeExhausted = true
			assetAbort.abort()
			warnings.add(
				'Asset inlining time budget was exhausted; remaining resources use absolute URLs.',
			)
		}
		return assetTimeExhausted
	}
	async function download(target: string, cap: number, accept: string, font = false) {
		const controller = new AbortController()
		const requestDeadline = AbortSignal.timeout(Math.max(1, limits.requestTimeoutMs))
		const signal = AbortSignal.any([
			deadline,
			requestDeadline,
			controller.signal,
			...(pageDownloaded ? [assetAbort.signal] : []),
		])
		let response: Response | undefined
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
		try {
			if (signal.aborted || (pageDownloaded && assetsExpired()))
				throw new PreviewCaptureError('FETCH_FAILED')
			response = await bounded(
				safeFetch(target, {
					signal,
					headers: {
						'User-Agent':
							'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
						Accept: accept,
						...(font ? { Origin: 'null' } : {}),
					},
				}),
				signal,
			)
			if (
				[401, 403, 429].includes(response.status) ||
				response.headers.get('cf-mitigated') === 'challenge'
			)
				throw new PreviewCaptureError('BLOCKED_BY_SITE')
			if (!response.ok) throw new PreviewCaptureError('FETCH_FAILED')
			if (font && response.headers.get('access-control-allow-origin') === '*') {
				void response.body?.cancel().catch(() => {})
				return { response, bytes: Buffer.alloc(0) }
			}
			if (Number(response.headers.get('content-length')) > cap)
				throw new PreviewCaptureError('TOO_LARGE')
			const chunks: Uint8Array[] = []
			let size = 0
			reader = response.body?.getReader()
			if (reader) {
				while (true) {
					const { done, value } = await bounded(reader.read(), signal)
					if (done) break
					size += value.byteLength
					if (size > cap) throw new PreviewCaptureError('TOO_LARGE')
					chunks.push(value)
				}
			}
			return { response, bytes: Buffer.concat(chunks, size) }
		} catch (error) {
			if (
				pageDownloaded &&
				(deadline.aborted || requestDeadline.aborted || Date.now() >= expiresAt)
			) {
				assetTimeExhausted = true
				assetsExpired()
			}
			controller.abort()
			if (reader) void reader.cancel().catch(() => {})
			else if (response) void response.body?.cancel().catch(() => {})
			if (error instanceof PreviewCaptureError) throw error
			throw new PreviewCaptureError('FETCH_FAILED')
		} finally {
			try {
				reader?.releaseLock()
			} catch {
				/* Cancellation can leave a pending read. */
			}
		}
	}
	async function fetchPage(target: string) {
		const page = await download(
			target,
			limits.pageBytes,
			'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
		)
		const type = page.response.headers.get('content-type') ?? ''
		if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(type))
			throw new PreviewCaptureError('NOT_HTML')
		return { url: page.response.url || target, source: decode(page.bytes, type, true) }
	}
	// Static site generators publish moved posts as instant meta-refresh pages (Hugo, Zola
	// and Jekyll aliases). Follow a few, like the HTTP redirects the guarded fetch takes.
	let page = await fetchPage(url)
	for (let hop = 0; hop < 3; hop++) {
		const next = refreshTarget(page.source, page.url)
		if (!next) break
		page = await fetchPage(next)
	}
	pageDownloaded = true
	// Challenge pages set `_cf_chl_opt` and load `/cdn-cgi/challenge-platform/h/…`. Plain
	// `challenge-platform` also matches the passive `scripts/jsd` beacon Cloudflare bot
	// management injects into every normal page, so it must not count on its own.
	const parsePage = (source: string) => {
		if (
			/<title[^>]*>\s*just a moment[.!…\s]*<\/title|_cf_chl_opt|\/cdn-cgi\/challenge-platform\/h\//i.test(
				source,
			)
		)
			throw new PreviewCaptureError('BLOCKED_BY_SITE')
		const doc = loadHtml(source)
		if (
			doc('body').text().trim().length < 400 &&
			/just a moment(?:\.{2,}|…)/i.test(doc('body').text())
		)
			throw new PreviewCaptureError('BLOCKED_BY_SITE')
		return doc
	}
	let finalUrl = page.url
	let $ = parsePage(page.source)
	let slots: ReturnType<typeof detectSlots>
	try {
		slots = detectSlots($, options)
	} catch (error) {
		// Served HTML with no article but scripts: the scripts may build it. Load the page
		// once in a browser and copy what they drew.
		if (
			!options.render ||
			!(error instanceof PreviewCaptureError) ||
			!RENDERABLE.has(error.code) ||
			!$('script').length
		)
			throw error
		expiresAt += limits.renderTimeoutMs
		armDeadline()
		const renderSignal = AbortSignal.any([
			deadline,
			AbortSignal.timeout(Math.max(1, limits.renderTimeoutMs)),
		])
		let rendered: RenderedPage
		try {
			rendered = await bounded(options.render(finalUrl, renderSignal), renderSignal)
		} catch (cause) {
			throw new PreviewCaptureError('RENDER_FAILED', { cause })
		}
		if (rendered.status !== null && [401, 403, 429].includes(rendered.status))
			throw new PreviewCaptureError('BLOCKED_BY_SITE')
		if (rendered.status !== null && rendered.status >= 400)
			throw new PreviewCaptureError('FETCH_FAILED')
		if (Buffer.byteLength(rendered.html) > limits.pageBytes)
			throw new PreviewCaptureError('TOO_LARGE')
		$ = parsePage(rendered.html)
		finalUrl = rendered.finalUrl ?? finalUrl
		try {
			slots = detectSlots($, options)
		} catch (renderedError) {
			// Even with its scripts run the page shows no article (a login wall, a block on
			// automated browsers): "built by JavaScript" no longer describes it.
			if (
				renderedError instanceof PreviewCaptureError &&
				(renderedError.code === 'CLIENT_RENDERED' || renderedError.code === 'NO_ARTICLE_FOUND')
			)
				throw new PreviewCaptureError('NO_ARTICLE_FOUND')
			throw renderedError
		}
		warnings.add(
			"Loaded in a browser because the page's HTML had no article; the layout is what its scripts drew.",
		)
	}
	const body = $('[data-innolope-slot="body"]').first()
	const classMap: Record<string, string> = {}
	for (const tag of 'p h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code a img figure figcaption table thead tbody tr th td hr strong em'.split(
		' ',
	)) {
		const counts = new Map<string, number>()
		body.find(tag).each((_i, el) => {
			if (tag === 'code' && $(el).parents('pre').length) return
			const cls = $(el).attr('class')?.trim()
			if (cls) counts.set(cls, (counts.get(cls) ?? 0) + 1)
		})
		let best = 0
		for (const [cls, count] of counts)
			if (count > best) {
				classMap[tag] = cls
				best = count
			}
	}
	body.contents().each((_i, node) => {
		if ($(node).is('[data-innolope-slot]') || $(node).find('[data-innolope-slot]').length) return
		$(node).remove()
	})

	$('img').each((_i, el) => {
		const img = $(el)
		const lazy = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original')
		if (lazy) img.attr('src', lazy)
		if (img.attr('data-srcset')) img.attr('srcset', img.attr('data-srcset') ?? '')
	})
	$('script,noscript,iframe,frame,frameset,object,embed,applet,portal,base').remove()
	$('meta[http-equiv]').each((_i, el) => {
		if (
			/^(refresh|set-cookie|content-security-policy)$/i.test($(el).attr('http-equiv')?.trim() ?? '')
		)
			$(el).remove()
	})
	$('link[rel]').each((_i, el) => {
		if (/\b(preload|modulepreload|prefetch|prerender|manifest)\b/i.test($(el).attr('rel') ?? ''))
			$(el).remove()
	})
	$('meta[charset]').remove()
	$('meta[http-equiv]').each((_i, el) => {
		if (/^content-type$/i.test($(el).attr('http-equiv') ?? '')) $(el).remove()
	})
	$('*').each((_i, el) => {
		if (!('attribs' in el)) return
		for (const [name, value] of Object.entries(el.attribs)) {
			// `target` too: the preview pins every link to its <base target>, which a
			// link's own `target="_self"` would override and navigate the frame away.
			if (/^on/i.test(name) || /^(srcdoc|action|formaction|target)$/i.test(name) || badUrl(value)) {
				$(el).removeAttr(name)
				continue
			}
			if (/^(href|src|poster|xlink:href|data-src|data-lazy-src|data-original)$/i.test(name))
				$(el).attr(name, absolute(value, finalUrl))
			if (/^(srcset|data-srcset)$/i.test(name)) $(el).attr(name, rewriteSrcset(value, finalUrl))
			if (name === 'style') $(el).attr(name, rewriteCssUrls(value, finalUrl))
		}
	})
	$('head').prepend($('<base>').attr('href', finalUrl))
	$('head').prepend('<meta charset="utf-8">')

	let activeAssets = 0
	const assetQueue: Array<() => void> = []
	async function withAssetSlot<T>(work: () => Promise<T>): Promise<T | null> {
		if (assetsExpired()) return null
		if (activeAssets < 6) activeAssets++
		else await new Promise<void>((resolve) => assetQueue.push(resolve))
		try {
			return assetsExpired() ? null : await work()
		} finally {
			const next = assetQueue.shift()
			if (next) next()
			else activeAssets--
		}
	}
	type AssetKind = 'font' | 'css'
	const reserved = { font: 0, css: 0 }
	const budgetChanged = new Set<() => void>()
	async function reserveBytes(kind: AssetKind): Promise<number | null> {
		const maximum = kind === 'font' ? limits.fontBytes : limits.stylesheetBytes
		const total = kind === 'font' ? limits.totalFontBytes : limits.totalCssBytes
		while (!assetsExpired()) {
			const available = total - (kind === 'font' ? fontBytes : cssBytes) - reserved[kind]
			if (maximum > 0 && available > 0) {
				const cap = Math.min(maximum, available)
				reserved[kind] += cap
				return cap
			}
			if (maximum <= 0 || reserved[kind] === 0) {
				warnings.add(
					kind === 'font'
						? 'Font byte budget was exhausted; remaining fonts use absolute URLs.'
						: 'Stylesheet count or total CSS byte limit reached; remaining stylesheets use absolute links.',
				)
				return null
			}
			await new Promise<void>((resolve) => budgetChanged.add(resolve))
		}
		return null
	}
	async function assetDownload(ref: string, kind: AssetKind) {
		const cap = await reserveBytes(kind)
		if (cap === null) return null
		let size = 0
		try {
			const result = await withAssetSlot(async () => {
				if (kind === 'css') stats.stylesheets++
				return download(
					ref,
					cap,
					kind === 'font' ? 'font/woff2,font/*;q=0.9,*/*;q=0.8' : 'text/css,*/*;q=0.1',
					kind === 'font',
				)
			})
			size = result?.bytes.length ?? 0
			return result
		} finally {
			reserved[kind] -= cap
			if (kind === 'font') fontBytes += size
			else cssBytes += size
			for (const wake of budgetChanged) wake()
			budgetChanged.clear()
		}
	}
	const fontCache = new Map<string, Promise<string>>()
	function inlineFont(ref: string): Promise<string> {
		const cached = fontCache.get(ref)
		if (cached) return cached
		const pending = (async () => {
			try {
				const font = await assetDownload(ref, 'font')
				if (!font || font.response.headers.get('access-control-allow-origin') === '*') return ref
				const mime =
					font.response.headers.get('content-type')?.split(';')[0] ||
					(/\.woff2(?:\?|$)/i.test(ref) ? 'font/woff2' : 'application/octet-stream')
				stats.inlinedFonts++
				return `data:${mime};base64,${font.bytes.toString('base64')}`
			} catch {
				if (!assetsExpired()) warnings.add(`Could not inline font within capture limits: ${ref}`)
				return ref
			}
		})()
		fontCache.set(ref, pending)
		return pending
	}
	async function processCss(
		input: string,
		base: string,
		depth: number,
		ancestors: Set<string>,
	): Promise<string> {
		const imports =
			/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi
		const importMatches = cssMatches(input, imports)
		const importedCss = await Promise.all(
			importMatches.map(async (match) => {
				const ref = absolute(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], base)
				const media = match[6].trim()
				const fallback = `@import url("${ref}")${media ? ` ${media}` : ''};`
				if (!ref || /\b(layer|supports)\b/i.test(media)) return fallback
				if (depth >= limits.maxImportDepth || ancestors.has(ref)) {
					warnings.add(`Import depth or cycle limit reached: ${ref}`)
					return fallback
				}
				const imported = await stylesheet(ref, depth + 1, new Set([...ancestors, ref]))
				return imported === null ? fallback : media ? `@media ${media}{${imported}}` : imported
			}),
		)
		let css = ''
		let offset = 0
		for (const [index, match] of importMatches.entries()) {
			css += input.slice(offset, match.index) + importedCss[index]
			offset = (match.index ?? 0) + match[0].length
		}
		css += input.slice(offset)
		css = rewriteCssUrls(css, base)
		const faces = cssMatches(css, /@font-face\s*\{[^}]*\}/gi)
		const inlinedFaces = await Promise.all(
			faces.map(async (face) => {
				if (!usesPreviewScripts(face[0])) return face[0]
				const block = valueParser(face[0])
				const refs: FunctionNode[] = []
				block.walk((node) => {
					if (node.type === 'function' && node.value.toLowerCase() === 'url') {
						refs.push(node)
						return false
					}
				})
				refs.sort(
					(a, b) =>
						Number(/woff2/i.test(b.nodes[0]?.value ?? '')) -
						Number(/woff2/i.test(a.nodes[0]?.value ?? '')),
				)
				await Promise.all(
					refs.map(async (node) => {
						const ref = node.nodes[0]?.value
						if (!ref || ref.startsWith('data:')) return
						const replacement = await inlineFont(ref)
						if (node.nodes[0]) node.nodes[0].value = replacement
					}),
				)
				return block.toString()
			}),
		)
		let result = ''
		offset = 0
		for (const [index, face] of faces.entries()) {
			result += css.slice(offset, face.index) + inlinedFaces[index]
			offset = (face.index ?? 0) + face[0].length
		}
		return result + css.slice(offset)
	}
	let sheetRequests = 0
	async function stylesheet(
		ref: string,
		depth: number,
		ancestors: Set<string>,
	): Promise<string | null> {
		if (assetsExpired()) return null
		if (sheetRequests >= limits.maxStylesheets) {
			warnings.add(
				'Stylesheet count or total CSS byte limit reached; remaining stylesheets use absolute links.',
			)
			return null
		}
		sheetRequests++
		try {
			const sheet = await assetDownload(ref, 'css')
			if (!sheet) return null
			return await processCss(
				decode(sheet.bytes, sheet.response.headers.get('content-type') ?? ''),
				sheet.response.url || ref,
				depth,
				ancestors,
			)
		} catch {
			if (!assetsExpired()) warnings.add(`Could not inline stylesheet: ${ref}`)
			return null
		}
	}
	const inlineStyles = $('style').toArray()
	for (const el of inlineStyles) cssBytes += Buffer.byteLength($(el).text())
	await Promise.all([
		...inlineStyles.map(async (el) => {
			const input = $(el).text()
			$(el).text(escapeStyle(await processCss(input, finalUrl, 0, new Set())))
		}),
		...$('link[rel~="stylesheet"]')
			.toArray()
			.map(async (el) => {
				const link = $(el)
				const ref = link.attr('href')
				if (!ref) return
				const css = await stylesheet(ref, 0, new Set([ref]))
				if (css === null) return
				const style = $('<style>').attr('data-innolope-href', ref).text(escapeStyle(css))
				if (link.attr('media')) style.attr('media', link.attr('media') ?? '')
				link.replaceWith(style)
			}),
	])
	assetsExpired()
	const html = $.html()
	stats.bytes = Buffer.byteLength(html)
	if (stats.bytes > limits.templateBytes) throw new PreviewCaptureError('TOO_LARGE')
	return {
		sourceUrl: url,
		finalUrl,
		html,
		slots,
		classMap,
		warnings: [...warnings],
		stats,
		capturedAt: new Date().toISOString(),
	}
}

/** Class/id tokens of page regions that are never the article. */
const CHROME_TOKENS =
	/(?:^|[\s_-])(comment|sidebar|related|share|newsletter|cookie|menu|nav|footer|promo|ad)(?:$|[\s_-])/i

/** Class/id tokens of images that are never the post's cover. */
const NOT_COVER_TOKENS =
	/(?:^|[\s_-])(avatar|author|bio|byline|logo|icon|gravatar|profile)(?:$|[\s_-])/i

/** Media a site may draw its cover with instead of an `<img>`. */
const DRAWN = 'svg,canvas,video'

/** A plain CSS identifier: safe to put in a selector without escaping. */
const CSS_IDENT = /^-?[_a-zA-Z][\w-]*$/

/**
 * A readable selector for an element of the ORIGINAL page (`div.post-body`,
 * `article > h1.entry-title`), shown to admins as what detection found and
 * reusable as an override on the next capture. Overrides take the first match,
 * so the selector only has to find this element first. Utility classes with
 * `:` or `/` (`md:text-lg`, `w-1/2`) are skipped rather than escaped.
 */
function describeElement($: CheerioAPI, el: ReturnType<CheerioAPI>): string {
	const parts: string[] = []
	let node = el
	for (let depth = 0; depth < 4 && node.length && !node.is('html,body'); depth++) {
		const id = node.attr('id')
		if (id && CSS_IDENT.test(id) && $(`#${id}`).length === 1) {
			parts.unshift(`#${id}`)
			break
		}
		const tag = (node[0] as { name?: string }).name?.toLowerCase() ?? '*'
		const classes = (node.attr('class') ?? '')
			.split(/\s+/)
			.filter((c) => CSS_IDENT.test(c))
			.slice(0, 3)
		parts.unshift(classes.length ? `${tag}.${classes.join('.')}` : tag)
		if ($(parts.join(' > ')).first()[0] === el[0]) break
		node = node.parent()
	}
	return parts.join(' > ')
}

function detectSlots(
	$: CheerioAPI,
	options: { selectors?: PreviewSelectors; hints?: { title?: string; bodyText?: string } },
): PreviewTemplate['slots'] {
	type Selection = ReturnType<CheerioAPI>
	const removed = 'script,style,noscript,iframe,frame,frameset,object,embed,applet,portal'
	const candidates = $('body *').filter((_i, el) => !$(el).closest(removed).length)
	// The page containers carry layout and taxonomy classes (`has-sidebar`, `menu-open`,
	// WordPress's `tag-newsletter`) that say nothing about the article itself. Utility
	// classes with selectors in them (`[&_[data-comment]_p]:text-sm`) are styling, not names.
	const names = (item: Selection) =>
		`${item.attr('class') ?? ''} ${item.attr('id') ?? ''}`
			.split(/\s+/)
			.filter((token) => CSS_IDENT.test(token))
			.join(' ')
	const tokenChrome = (item: Selection) =>
		!item.is('html,body,main,article') && CHROME_TOKENS.test(names(item))
	const chrome = (el: Selection) =>
		el
			.parents()
			.addBack()
			.toArray()
			.some((node) => {
				const item = $(node)
				return (
					item.is(`nav,footer,aside,${removed}`) ||
					tokenChrome(item) ||
					(item.is('header') && !item.closest('article').length)
				)
			})
	// The post's lead (title, cover image) often sits in a page-level <header> outside
	// <article> (`<main><header><h1>`), which `chrome` rejects. For the lead only the site
	// header — the one carrying the navigation — is chrome; an article's own header may
	// hold a tag or breadcrumb nav.
	const leadChrome = (el: Selection) =>
		el
			.parents()
			.addBack()
			.toArray()
			.some((node) => {
				const item = $(node)
				return (
					item.is(`nav,footer,aside,${removed}`) ||
					tokenChrome(item) ||
					(item.is('header') && item.find('nav').length > 0 && !item.closest('article').length)
				)
			})
	const prose = (el: Selection) => {
		const paragraphs = el
			.find('p')
			.add(el.filter('p'))
			.filter((_i, p) => !chrome($(p)))
		return (
			paragraphs.filter((_i, p) => normalize($(p).text()).length > 0).length >= 3 ||
			normalize(paragraphs.text()).length >= 400
		)
	}
	const override = (slot: keyof PreviewSelectors): Selection | null => {
		const selector = options.selectors?.[slot]
		if (selector === undefined) return null
		try {
			const el = $(selector).first()
			if (
				!el.length ||
				el.is('html,head,script,style,base,meta,link') ||
				el.closest(removed).length ||
				(slot === 'image' && !el.is(`img,${DRAWN}`) && !el.find(`img,${DRAWN}`).length)
			)
				throw new Error('unusable')
			// An image override may name the cover's wrapper (`figure.cover`).
			return slot === 'image' && !el.is('img') && el.find('img').length
				? el.find('img').first()
				: el
		} catch {
			throw new PreviewCaptureError('SELECTOR_NOT_FOUND')
		}
	}
	const titleOverride = override('title')
	const imageOverride = override('image')
	let body = override('body')
	let bodyStrategy: PreviewSlotInfo['strategy'] = 'override'
	if (!body && options.hints?.bodyText) {
		const hint = normalize(options.hints.bodyText).slice(0, 80)
		if (hint) {
			const matches = candidates
				.filter((_i, el) => !chrome($(el)) && normalize($(el).text()).includes(hint))
				.toArray()
				.reverse()
			for (const node of matches) {
				let el = $(node)
				if (el.is('p,h2,h3,h4,h5,h6,li')) el = el.parent()
				if (prose(el)) {
					body = el
					bodyStrategy = 'record-match'
					break
				}
			}
		}
	}
	if (!body) {
		const semantic = $(
			'[itemprop="articleBody"],.entry-content,.post-content,.article-content,.article-body,.post-body,.prose,.markdown-body,.content-body',
		)
			.filter((_i, el) => !chrome($(el)) && prose($(el)))
			.first()
		if (semantic.length) {
			body = semantic
			bodyStrategy = 'semantic'
		}
	}
	if (!body) {
		let best = 0
		candidates.each((_i, node) => {
			const el = $(node)
			if (chrome(el) || !prose(el)) return
			const score = normalize(
				el
					.children('p,h2,h3,h4,h5,h6,ul,ol,blockquote,pre')
					.filter((_j, child) => !chrome($(child)))
					.text(),
			).length
			if (score > best) {
				body = el
				best = score
				bodyStrategy = 'heuristic'
			}
		})
	}
	if (!body) {
		const visible = $('body').clone()
		visible.find('script,style,noscript').remove()
		const emptyMount = $('#root,#__next,#app,#__nuxt,#___gatsby')
			.toArray()
			.some((el) => normalize($(el).text()).length < 80)
		throw new PreviewCaptureError(
			emptyMount || ($('script').length && normalize(visible.text()).length < 200)
				? 'CLIENT_RENDERED'
				: 'NO_ARTICLE_FOUND',
		)
	}
	let bodyEl: Selection = body
	// Long articles are often split into sibling <section>s, each of which reads as prose
	// on its own, so the heuristic lands on one of them; the article is their parent.
	// (The cast: TS doesn't see the assignment inside `candidates.each` above.)
	while (
		(bodyStrategy as PreviewSlotInfo['strategy']) === 'heuristic' &&
		bodyEl.parent().length &&
		!bodyEl.parent().is('body') &&
		!chrome(bodyEl.parent()) &&
		bodyEl
			.parent()
			.children()
			.filter((_i, sibling) => !chrome($(sibling)) && prose($(sibling))).length >= 2
	)
		bodyEl = bodyEl.parent()
	// The lead sits around the body: in the <article> or <main> holding it, or just above
	// the body when the body is the <article> itself.
	const container = bodyEl.parent().closest('article,main')
	const scope = container.length ? container : $('body')
	const pageTitle = normalize($('meta[property="og:title"]').attr('content') || $('title').text())
	// Blog templates often put the site name in an h1 above the post's own
	// (`<h1><a href="/blog/">The Go Blog</a></h1>`): prefer the longest h1 the page title names.
	const headings = scope
		.find('h1')
		.filter((_i, el) => !leadChrome($(el)))
		.toArray()
		.map((el) => ({ el, text: normalize($(el).text()) }))
		.sort(
			(a, b) =>
				Number(!!b.text && pageTitle.includes(b.text)) * b.text.length -
				Number(!!a.text && pageTitle.includes(a.text)) * a.text.length,
		)
		.map(({ el }) => $(el))
	let title = titleOverride
	let titleStrategy: PreviewSlotInfo['strategy'] = 'override'
	if (!title && options.hints?.title) {
		const match = $('h1,h2')
			.filter((_i, el) => !chrome($(el)))
			.filter((_i, el) => normalize($(el).text()) === normalize(options.hints?.title ?? ''))
			.first()
		if (match.length) {
			title = match
			titleStrategy = 'record-match'
		}
	}
	if (!title && headings.length) {
		title = headings[0]
		titleStrategy = 'semantic'
	}
	if (!title) {
		const match = $('h1,h2')
			.filter(
				(_i, el) =>
					!leadChrome($(el)) &&
					!!normalize($(el).text()) &&
					pageTitle.includes(normalize($(el).text())),
			)
			.first()
		if (match.length) {
			title = match
			titleStrategy = 'heuristic'
		}
	}
	const basename = (ref: string) => {
		try {
			return new URL(ref, 'https://example.com').pathname
				.split('/')
				.pop()
				?.replace(/-\d+x\d+(?=\.[^.]+$)/, '')
		} catch {
			return undefined
		}
	}
	const eligibleImage = (el: Selection) => {
		if (leadChrome(el)) return false
		// Author photos, avatars and logos are never the cover, whatever wraps them.
		const declared = (name: string) => Number(el.attr(name) || Number.NaN)
		if (declared('width') < 300 || declared('height') < 150) return false
		if (
			el
				.add(el.parents().slice(0, 3))
				.toArray()
				.some((node) => NOT_COVER_TOKENS.test(names($(node))))
		)
			return false
		const inBody: Array<Selection[0]> = bodyEl.find('*').toArray()
		const position = inBody.indexOf(el[0])
		if (position < 0) return true
		// Inside the body only a lead image counts: one that comes before any prose. Byline
		// and notice paragraphs in the body's own header aren't prose.
		const firstProse = bodyEl
			.find('p')
			.filter((_i, p) => !!normalize($(p).text()) && !inBody.includes($(p).closest('header')[0]))
			.first()[0]
		return !firstProse || position < inBody.indexOf(firstProse)
	}
	// Image components often declare `width="100%"` and no <figure>; the page still marks
	// its lead image: the browser's priority hint, the post's own title as alt text, or
	// a srcset offering it at large sizes.
	const titleText = normalize(title?.text() ?? '')
	const leadSignal = (el: Selection) => {
		if (el.attr('fetchpriority')?.trim().toLowerCase() === 'high') return true
		const alt = normalize(el.attr('alt') ?? '')
		if (alt && titleText && alt === titleText) return true
		const widths = (el.attr('srcset') ?? el.attr('data-srcset') ?? '')
			.split(',')
			.map((candidate) => /\s(\d+)w\s*$/.exec(candidate.trim())?.[1])
			.map(Number)
			.filter(Number.isFinite)
		return widths.length > 0 && Math.max(...widths) >= 600
	}
	let image = imageOverride
	let imageStrategy: PreviewSlotInfo['strategy'] = 'override'
	const order: Array<Selection[0]> = scope.find('*').toArray()
	const beforeBody = new Set(order.slice(0, order.indexOf(bodyEl[0])))
	if (!image) {
		const og = $('meta[property="og:image"],meta[name="twitter:image"]').first().attr('content')
		if (og) {
			const match = scope
				.find('img')
				.filter(
					(_i, el) =>
						eligibleImage($(el)) &&
						['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-original'].some(
							(attr) =>
								($(el).attr(attr) ?? '')
									.split(/[,\s]+/)
									.some((ref) => ref && basename(ref) === basename(og)),
						),
				)
				.first()
			if (match.length) {
				image = match
				imageStrategy = 'semantic'
			}
		}
		if (!image) {
			const match = scope
				.find('img')
				.filter(
					(_i, el) =>
						eligibleImage($(el)) &&
						(beforeBody.has(el) || bodyEl.find('img').toArray().includes(el)) &&
						($(el).closest('figure,picture').length > 0 ||
							Number($(el).attr('width')) >= 400 ||
							Number($(el).attr('height')) >= 250 ||
							leadSignal($(el))),
				)
				.first()
			if (match.length) {
				image = match
				imageStrategy = 'heuristic'
			}
		}
		if (!image) {
			// Some sites draw the cover inline (`<figure><svg viewBox="0 0 1200 460">`).
			const match = scope
				.find('figure')
				.filter((_i, el) => {
					const media = $(el).find(DRAWN).first()
					const width =
						Number(media.attr('width')) ||
						Number((media.attr('viewBox') ?? '').trim().split(/[\s,]+/)[2])
					return (
						media.length > 0 &&
						(media.is('video') || width >= 400) &&
						eligibleImage($(el)) &&
						(beforeBody.has(el) || bodyEl.find('figure').toArray().includes(el))
					)
				})
				.first()
			if (match.length) {
				image = match
				imageStrategy = 'heuristic'
			}
		}
	}
	if (title?.is(bodyEl) || image?.is(bodyEl) || (title && image?.is(title)))
		throw new PreviewCaptureError('SELECTOR_NOT_FOUND')
	// A drawn cover belongs to the sample article: it gives way to an <img> that the
	// record's cover fills, or that hides along with its frame when the record has none.
	const imageSelector = image ? describeElement($, image) : undefined
	if (image && !image.is('img')) {
		const media = image.is(DRAWN) ? image : image.find(DRAWN).first()
		const img = $('<img alt="">').attr('style', 'display:block;width:100%;height:auto')
		image.removeAttr('aria-label').removeAttr('aria-labelledby')
		media.replaceWith(img)
		image = img
	}
	$('[data-innolope-slot]').removeAttr('data-innolope-slot')
	function mark(
		el: Selection | null,
		slot: string,
		strategy: PreviewSlotInfo['strategy'],
		described?: string,
	): PreviewSlotInfo | null {
		if (!el?.length) return null
		const selector =
			options.selectors?.[slot as keyof PreviewSelectors] ?? described ?? describeElement($, el)
		el.attr('data-innolope-slot', slot)
		return {
			selector,
			strategy,
			sample: (slot === 'image'
				? el.attr('src') || el.attr('data-src') || ''
				: normalize(el.text())
			).slice(0, 160),
		}
	}
	return {
		title: mark(title, 'title', titleStrategy),
		image: mark(image, 'image', imageStrategy, imageSelector),
		body: mark(bodyEl, 'body', bodyStrategy) as PreviewSlotInfo,
	}
}
