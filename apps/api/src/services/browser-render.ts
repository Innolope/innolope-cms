/**
 * Loads a page in Cloudflare Browser Run (the REST "Quick Actions" `/content`
 * endpoint) and returns the HTML its scripts produced. The preview capture uses it
 * for sites whose served HTML is an empty shell that JavaScript fills in.
 *
 * The browser runs on Cloudflare's network, not ours, so a pasted URL can't use it
 * to reach internal services; the capture still validates the URL first.
 */

export interface RenderedPage {
	html: string
	/** Where the browser ended up after redirects, when Browser Run reports it. */
	finalUrl: string | null
	/** The origin's HTTP status for the page, when reported. */
	status: number | null
	/** Browser time the request was billed for (`X-Browser-Ms-Used`). */
	browserMs: number | null
}

export type PageRenderer = (url: string, signal: AbortSignal) => Promise<RenderedPage>

/**
 * `busy`: rate-limited, here or at Cloudflare; worth retrying in a minute.
 * `unavailable`: the token is wrong or lacks the Browser Rendering permission.
 * `failed`: anything else (timeout, malformed response, page error).
 */
export type BrowserRenderFailure = 'busy' | 'unavailable' | 'failed'

export class BrowserRenderError extends Error {
	constructor(
		readonly reason: BrowserRenderFailure,
		message: string,
	) {
		super(message)
		this.name = 'BrowserRenderError'
	}
}

export interface BrowserRunConfig {
	accountId: string
	apiToken: string
	fetch?: typeof fetch
	/** Renders in flight at once; more are refused, not queued. */
	maxConcurrent?: number
	/** Renders started in any 60-minute window. Bounds what a burst can cost. */
	maxPerHour?: number
	now?: () => number
}

const HOUR_MS = 60 * 60 * 1000
/** Browser Run's own ceiling for `gotoOptions.timeout`. */
const NAVIGATION_TIMEOUT_MS = 15_000

/**
 * Runs inside the rendered page and readies it for the snapshot:
 *
 * - CSS-in-JS libraries in production (emotion's "speedy" mode behind MUI,
 *   styled-components) add rules with `insertRule`, which leaves the `<style>`
 *   element's text empty: the page looks styled, but its HTML carries none of the
 *   CSS. Write the live rules back into the text and add constructed stylesheets as
 *   `<style>` elements.
 * - A browser that loads the page is a first-time visitor, so scripts pin a cookie
 *   consent banner over the article. Remove pinned (`position: fixed`) boxes whose
 *   text is a sentence about cookies or consent; article text that mentions cookies
 *   isn't pinned, and a short "Cookies" link in a fixed header doesn't count.
 *
 * It repeats until the snapshot is taken, since both can appear late.
 */
export const PAGE_SNAPSHOT_SCRIPT = `(() => {
	const read = (sheet) => {
		try {
			return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\\n')
		} catch {
			return null
		}
	}
	const adopted = new Map()
	const serialize = () => {
		for (const el of document.querySelectorAll('style')) {
			if (!el.sheet || el.hasAttribute('data-innolope-adopted')) continue
			const text = read(el.sheet)
			if (text && text.length > (el.textContent || '').length) el.textContent = text
		}
		for (const sheet of document.adoptedStyleSheets || []) {
			const text = read(sheet)
			if (!text) continue
			let el = adopted.get(sheet)
			if (!el) {
				el = document.createElement('style')
				el.setAttribute('data-innolope-adopted', '')
				document.head.append(el)
				adopted.set(sheet, el)
			}
			if (el.textContent !== text) el.textContent = text
		}
	}
	const consent = /cookie|consent|gdpr|куки|кукі/i
	const dropConsentBanners = () => {
		if (!document.body) return
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
		const hits = []
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.data.trim().length >= 40 && consent.test(node.data)) hits.push(node)
		}
		for (const node of hits) {
			let el = node.parentElement
			for (let depth = 0; el && el !== document.body && depth < 8; depth++) {
				if (getComputedStyle(el).position === 'fixed') {
					if ((el.textContent || '').length < 2000) el.remove()
					break
				}
				el = el.parentElement
			}
		}
	}
	const prepare = () => {
		serialize()
		dropConsentBanners()
	}
	prepare()
	setInterval(prepare, 250)
})()`

export function createBrowserRenderer(config: BrowserRunConfig): PageRenderer {
	const maxConcurrent = config.maxConcurrent ?? 3
	const maxPerHour = config.maxPerHour ?? 200
	const now = config.now ?? Date.now
	const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/browser-rendering/content?cacheTTL=0`
	let inFlight = 0
	const started: number[] = []

	return async (url, signal) => {
		const at = now()
		while (started.length && started[0] <= at - HOUR_MS) started.shift()
		if (inFlight >= maxConcurrent || started.length >= maxPerHour)
			throw new BrowserRenderError(
				'busy',
				'Too many pages are being loaded in a browser right now.',
			)
		inFlight++
		started.push(at)
		try {
			let response: Response
			try {
				// Looked up per call, so the global fetch can be swapped (tests, instrumentation).
				response = await (config.fetch ?? globalThis.fetch)(endpoint, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${config.apiToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						url,
						gotoOptions: { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS },
						// Analytics and chat widgets can keep the network busy forever; take the
						// page as it is when the wait gives up.
						bestAttempt: true,
						addScriptTag: [{ content: PAGE_SNAPSHOT_SCRIPT }],
						// The HTML is all the capture keeps, so don't spend browser time on media.
						rejectResourceTypes: ['image', 'media', 'font'],
						viewport: { width: 1280, height: 800 },
					}),
					signal,
				})
			} catch {
				throw new BrowserRenderError('failed', 'The browser request did not complete.')
			}
			let payload: unknown = null
			try {
				payload = await response.json()
			} catch {
				payload = null
			}
			const body = (payload ?? {}) as {
				success?: unknown
				result?: unknown
				errors?: Array<{ code?: unknown }>
				meta?: { finalUrl?: unknown; status?: unknown }
			}
			const errorCodes = Array.isArray(body.errors) ? body.errors.map((e) => e?.code) : []
			if (response.status === 429 || errorCodes.includes(2001))
				throw new BrowserRenderError('busy', 'Browser Run is rate-limiting requests.')
			if (response.status === 401 || response.status === 403)
				throw new BrowserRenderError(
					'unavailable',
					`Browser Run refused the API token (HTTP ${response.status}).`,
				)
			if (!response.ok || body.success !== true || typeof body.result !== 'string')
				throw new BrowserRenderError(
					'failed',
					`Browser Run did not return a page (HTTP ${response.status}).`,
				)
			const finalUrl = httpUrl(body.meta?.finalUrl)
			const status = typeof body.meta?.status === 'number' ? body.meta.status : null
			const used = Number(response.headers.get('x-browser-ms-used'))
			return {
				html: body.result,
				finalUrl,
				status,
				browserMs: response.headers.has('x-browser-ms-used') && Number.isFinite(used) ? used : null,
			}
		} finally {
			inFlight--
		}
	}
}

/** `value` when it is a complete http(s) URL; the capture resolves the page's links against it. */
function httpUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null
	try {
		const url = new URL(value)
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
	} catch {
		return null
	}
}

/**
 * The renderer configured for this server, or null when it isn't (self-hosted
 * installs without a Browser Run token keep the plain capture only).
 */
export function browserRendererFromEnv(
	env: Record<string, string | undefined> = process.env,
): PageRenderer | null {
	const apiToken = env.CLOUDFLARE_BROWSER_RUN_API_TOKEN?.trim()
	const accountId =
		env.CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID?.trim() || env.CLOUDFLARE_ACCOUNT_ID?.trim()
	if (!apiToken || !accountId) return null
	return createBrowserRenderer({ accountId, apiToken })
}
