import type { ProjectSettings } from '@innolope/db'
import type { FastifyInstance } from 'fastify'

/**
 * Cover rendering via Cloudflare Browser Rendering.
 *
 * Why not a headless browser in this container: Chromium adds ~400MB to the API
 * image and 0.5–1GB of RSS while rendering, which is the wrong trade for a
 * feature that runs in bursts. Browser Rendering is the same engine as a
 * service, billed on duration only ($0.09/browser-hour, 10 hours/month included
 * on Workers Paid), so a full site backfill costs cents and the deploy stays
 * thin. Credentials resolve exactly like media storage, so a project that has
 * already connected Cloudflare needs no extra setup.
 */

const CF_API = 'https://api.cloudflare.com/client/v4'

export interface BrowserRenderingCreds {
	accountId: string
	apiToken: string
	/** Where the credentials came from — surfaced by /status for debugging. */
	source: 'oauth' | 'project-settings' | 'env'
}

export class CoverRenderConfigError extends Error {
	statusCode = 503
}

/**
 * Resolve Cloudflare credentials for Browser Rendering.
 *
 * Deliberately mirrors resolveMediaAdapter's precedence (OAuth connection →
 * project settings → env) so covers and media never end up in different
 * Cloudflare accounts for the same project.
 *
 * NOTE: the API token needs the `Browser Rendering — Edit` permission, which is
 * NOT implied by an Images token. A project can therefore have working media
 * uploads and still fail here; the 403 from Cloudflare is passed through with
 * that hint rather than being reported as a generic failure.
 */
export async function resolveBrowserRendering(
	app: FastifyInstance,
	projectId: string,
	settings: ProjectSettings | undefined,
): Promise<BrowserRenderingCreds> {
	const cf = settings?.cloudflare ?? {}

	if (cf.source === 'oauth' && cf.accountId) {
		const { getAccessToken } = await import('./cloudflare-oauth.js')
		const oauthToken = await getAccessToken(app, projectId)
		if (oauthToken) {
			return { accountId: cf.accountId, apiToken: oauthToken, source: 'oauth' }
		}
	}

	if (cf.accountId && cf.apiToken) {
		return { accountId: cf.accountId, apiToken: cf.apiToken, source: 'project-settings' }
	}

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
	const apiToken =
		process.env.CLOUDFLARE_BROWSER_RENDERING_TOKEN || process.env.CLOUDFLARE_API_TOKEN
	if (accountId && apiToken) {
		return { accountId, apiToken, source: 'env' }
	}

	throw new CoverRenderConfigError(
		'Cloudflare Browser Rendering is not configured. Connect Cloudflare in ' +
			'Settings → Media, or set CLOUDFLARE_ACCOUNT_ID and ' +
			'CLOUDFLARE_BROWSER_RENDERING_TOKEN (needs the "Browser Rendering — Edit" permission).',
	)
}

/** Stage sizes offered when a project has not declared its own. */
export const DEFAULT_COVER_FORMATS = [
	{ name: '3x2', width: 1200, height: 800 },
	// OpenGraph is 1.91:1, not 16:9 — close enough to look interchangeable, far
	// enough that the social crawlers crop it.
	{ name: 'og', width: 1200, height: 630 },
	{ name: '16x9', width: 1600, height: 900 },
	{ name: '1x1', width: 1200, height: 1200 },
	{ name: '3x2-portrait', width: 800, height: 1200 },
]

/**
 * Fetch the cover HTML for one record from the project's template endpoint.
 *
 * Kept separate from rendering so a template failure is reported as a template
 * failure — the two live in different systems and blur together badly in logs.
 */
export async function fetchCoverTemplate(
	templateUrl: string,
	params: { slug: string; format: string; section?: string | null },
	token?: string,
): Promise<string> {
	let url: URL
	try {
		url = new URL(templateUrl)
	} catch {
		throw new CoverRenderConfigError(`Cover template URL is not a valid URL: ${templateUrl}`)
	}
	url.searchParams.set('slug', params.slug)
	url.searchParams.set('format', params.format)
	if (params.section) url.searchParams.set('section', params.section)

	const res = await fetch(url, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		signal: AbortSignal.timeout(15_000),
	})
	if (!res.ok) {
		throw Object.assign(
			new Error(`Cover template returned ${res.status} for ${params.slug} (${params.format})`),
			{ statusCode: 502 },
		)
	}
	const html = await res.text()
	if (!html.trim()) {
		throw Object.assign(new Error('Cover template returned an empty document'), { statusCode: 502 })
	}
	return html
}

export interface RenderOptions {
	html: string
	width: number
	height: number
	/** 2 exports a 1200×800 stage at 2400×1600. */
	deviceScaleFactor?: number
	type?: 'png' | 'jpeg'
	/** jpeg only; ignored for png. */
	quality?: number
}

export interface RenderedImage {
	buffer: Buffer
	mimeType: string
	width: number
	height: number
}

/**
 * Render an HTML string to an image.
 *
 * The viewport is set to the exact stage size and the whole viewport is
 * captured, so no element selector is needed — the cover fills the frame by
 * construction. That keeps this independent of the markup the template emits.
 */
export async function renderCover(
	creds: BrowserRenderingCreds,
	opts: RenderOptions,
): Promise<RenderedImage> {
	const { html, width, height, deviceScaleFactor = 2, type = 'png', quality = 90 } = opts

	if (!html?.trim()) throw Object.assign(new Error('html is required'), { statusCode: 400 })
	if (!(width > 0 && height > 0)) {
		throw Object.assign(new Error('width and height must be positive'), { statusCode: 400 })
	}

	const res = await fetch(`${CF_API}/accounts/${creds.accountId}/browser-rendering/screenshot`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${creds.apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			html,
			viewport: { width, height, deviceScaleFactor },
			// Covers pull a photograph off the Unsplash CDN. Without waiting for the
			// network to settle, a slow fetch renders as an empty navy rectangle —
			// a silent, plausible-looking corruption that only shows up on review.
			gotoOptions: { waitUntil: 'networkidle0' },
			screenshotOptions: {
				type,
				...(type === 'jpeg' ? { quality } : {}),
				fullPage: false,
			},
		}),
	})

	if (!res.ok) {
		const detail = await res.text().catch(() => '')
		const hint =
			res.status === 403
				? ' — the API token needs the "Browser Rendering — Edit" permission (an Images token is not enough)'
				: res.status === 429
					? ' — Browser Rendering rate limit hit; retry or lower concurrency'
					: ''
		throw Object.assign(
			new Error(
				`Cloudflare Browser Rendering failed (${res.status})${hint}: ${detail.slice(0, 300)}`,
			),
			{ statusCode: res.status === 429 ? 429 : 502 },
		)
	}

	// The endpoint returns raw image bytes, but wraps the result in the standard
	// Cloudflare JSON envelope for some request shapes. Handle both rather than
	// betting on one.
	const contentType = res.headers.get('content-type') || ''
	let buffer: Buffer
	if (contentType.includes('application/json')) {
		const body = (await res.json()) as {
			success: boolean
			result?: string | { screenshot?: string }
			errors?: { message: string }[]
		}
		if (!body.success) {
			throw Object.assign(
				new Error(`Cloudflare Browser Rendering failed: ${body.errors?.[0]?.message ?? 'unknown'}`),
				{ statusCode: 502 },
			)
		}
		const b64 = typeof body.result === 'string' ? body.result : body.result?.screenshot
		if (!b64) {
			throw Object.assign(new Error('Browser Rendering returned no image'), { statusCode: 502 })
		}
		buffer = Buffer.from(b64, 'base64')
	} else {
		buffer = Buffer.from(await res.arrayBuffer())
	}

	if (!buffer.length) {
		throw Object.assign(new Error('Browser Rendering returned an empty image'), { statusCode: 502 })
	}

	return {
		buffer,
		mimeType: type === 'jpeg' ? 'image/jpeg' : 'image/png',
		width: Math.round(width * deviceScaleFactor),
		height: Math.round(height * deviceScaleFactor),
	}
}
