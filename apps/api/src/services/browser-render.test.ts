import { describe, expect, it, vi } from 'vitest'
import {
	BrowserRenderError,
	browserRendererFromEnv,
	createBrowserRenderer,
	PAGE_SNAPSHOT_SCRIPT,
} from './browser-render.js'

/*
 * Spec-only acceptance plan: .claude/specs/browser-render-capture.md.
 * What can go wrong: R1 request/abort contract drifts; R2 metadata is malformed;
 * R3 provider/network failures are misclassified; R4 credentials escape in errors;
 * R5 concurrent/hourly budgets leak or never recover; R6 absent config activates
 * billing; R7 injected JavaScript is not standalone. Freeze expectations before
 * implementation review. No live provider, global fetch replacement, or migration.
 */
const token = 'test-private-browser-token-never-echo'
const url = 'https://example.org/article?lang=en'
const signal = () => new AbortController().signal
const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
const success = () => jsonResponse({ success: true, result: '<article>Rendered</article>' })
const renderer = (fetch: typeof globalThis.fetch) =>
	createBrowserRenderer({ accountId: 'account-test', apiToken: token, fetch })

async function expectFailure(promise: Promise<unknown>, reason: string) {
	const error: unknown = await promise.then(
		() => undefined,
		(error: unknown) => error,
	)
	expect(error).toBeInstanceOf(BrowserRenderError)
	expect(error).toMatchObject({ reason })
	return error
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('Browser Run renderer acceptance', () => {
	it('R1 sends one authenticated uncached POST with the supplied abort signal and rendering options', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success())
		const abort = signal()
		await renderer(fetch)(url, abort)
		expect(fetch).toHaveBeenCalledTimes(1)
		const [requestUrl, init] = fetch.mock.calls[0]
		expect(String(requestUrl)).toBe(
			'https://api.cloudflare.com/client/v4/accounts/account-test/browser-rendering/content?cacheTTL=0',
		)
		expect(init?.method).toBe('POST')
		expect(init?.signal).toBe(abort)
		const headers = new Headers(init?.headers)
		expect(headers.get('Authorization')).toBe(`Bearer ${token}`)
		expect(headers.get('Content-Type')).toBe('application/json')
		const body = JSON.parse(String(init?.body))
		expect(body).toEqual({
			url,
			gotoOptions: { waitUntil: 'networkidle2', timeout: expect.any(Number) },
			bestAttempt: true,
			addScriptTag: [{ content: PAGE_SNAPSHOT_SCRIPT }],
			rejectResourceTypes: ['image', 'media', 'font'],
			viewport: { width: 1280, height: 800 },
		})
		expect(body.gotoOptions.timeout).toBeGreaterThan(0)
		expect(body.gotoOptions.timeout).toBeLessThanOrEqual(60_000)
	})

	it.each([
		['https://example.org/final', 201, '123.5', 'https://example.org/final', 201, 123.5],
		['http://example.org/final', 404, '0', 'http://example.org/final', 404, 0],
		['javascript:alert(1)', '200', 'not-a-number', null, null, null],
		['/relative', null, undefined, null, null, null],
		['ftp://example.org/file', {}, undefined, null, null, null],
		['https://', undefined, undefined, null, null, null],
		[42, true, undefined, null, null, null],
	])('R2 normalizes metadata %j / %j / %j', async (finalUrl, status, ms, expectedUrl, expectedStatus, expectedMs) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(
				jsonResponse(
					{ success: true, result: '<html>✓</html>', meta: { finalUrl, status } },
					200,
					ms === undefined ? {} : { 'X-Browser-Ms-Used': ms },
				),
			)
		expect(await renderer(fetch)(url, signal())).toEqual({
			html: '<html>✓</html>',
			finalUrl: expectedUrl,
			status: expectedStatus,
			browserMs: expectedMs,
		})
	})

	it.each([200, 201, 202])('R2 accepts %i success without optional metadata', async (status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(jsonResponse({ success: true, result: '' }, status))
		expect(await renderer(fetch)(url, signal())).toEqual({
			html: '',
			finalUrl: null,
			status: null,
			browserMs: null,
		})
	})

	it.each([
		[429, { success: false }, 'busy'],
		[200, { success: false, errors: [{ code: 1000 }, { code: 2001 }] }, 'busy'],
		[
			200,
			{ success: true, result: '<article>Ignored</article>', errors: [{ code: 2001 }] },
			'busy',
		],
		[500, { errors: [{ code: 2001 }] }, 'busy'],
		[401, { success: false }, 'unavailable'],
		[403, { success: false }, 'unavailable'],
		[400, { success: false }, 'failed'],
		[500, { success: false }, 'failed'],
		[302, { success: true, result: '<article>Ignored</article>' }, 'failed'],
		[200, { success: false, result: '<article>Ignored</article>' }, 'failed'],
		[200, { success: true }, 'failed'],
		[200, { success: true, result: null }, 'failed'],
		[200, { success: true, result: 7 }, 'failed'],
		[200, { success: true, result: {} }, 'failed'],
		[200, null, 'failed'],
	])('R3 maps HTTP %i and body %j to %s without retry', async (status, body, reason) => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body, status))
		await expectFailure(renderer(fetch)(url, signal()), reason)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it.each([200, 429, 401, 403, 502])('R3 handles non-JSON HTTP %i', async (status) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response('<html>upstream</html>', { status }))
		await expectFailure(
			renderer(fetch)(url, signal()),
			status === 429 ? 'busy' : status === 401 || status === 403 ? 'unavailable' : 'failed',
		)
	})

	it.each([
		new Error('network disconnected'),
		new DOMException('cancelled', 'AbortError'),
	])('R3 maps fetch rejection %s to failed without retry', async (error) => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error)
		await expectFailure(renderer(fetch)(url, signal()), 'failed')
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it.each([
		['body', 'failed'],
		['rejection', 'failed'],
		// The refused-token and rate-limit paths build their own messages.
		['401', 'unavailable'],
		['403', 'unavailable'],
		['429', 'busy'],
	] as const)('R4 removes credentials from all error properties after malicious %s', async (source, reason) => {
		const fetch = vi.fn<typeof globalThis.fetch>()
		if (source === 'body') {
			fetch.mockResolvedValue(
				jsonResponse({ success: false, errors: [{ message: token }], token }, 500),
			)
		} else if (source === 'rejection') {
			fetch.mockRejectedValue(
				Object.assign(new Error(`failed: ${token}`), { cause: { token }, token }),
			)
		} else {
			fetch.mockResolvedValue(
				jsonResponse({ success: false, errors: [{ message: token }], token }, Number(source)),
			)
		}
		const error = await expectFailure(renderer(fetch)(url, signal()), reason)
		const seen = new Set<object>()
		const inspect = (value: unknown) => {
			if (typeof value === 'string') expect(value).not.toContain(token)
			if (typeof value !== 'object' || value === null || seen.has(value)) return
			seen.add(value)
			for (const key of Reflect.ownKeys(value)) {
				expect(String(key)).not.toContain(token)
				inspect(Reflect.get(value, key))
			}
		}
		inspect(error)
	})

	it.each([
		'success',
		'rejection',
		'http-error',
		'malformed-json',
	] as const)('R5 rejects excess concurrency before fetch and frees a slot after %s', async (outcome) => {
		const first = deferred<Response>()
		const second = deferred<Response>()
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise)
			.mockResolvedValue(success())
		const render = createBrowserRenderer({
			accountId: 'account',
			apiToken: token,
			fetch,
			maxConcurrent: 2,
		})
		const pending = render(url, signal())
		const other = render(url, signal())
		await expectFailure(render(url, signal()), 'busy')
		expect(fetch).toHaveBeenCalledTimes(2)
		if (outcome !== 'success') {
			if (outcome === 'rejection') first.reject(new Error('network failed'))
			else if (outcome === 'http-error') first.resolve(jsonResponse({ success: false }, 500))
			else first.resolve(new Response('invalid JSON'))
			await expectFailure(pending, 'failed')
		} else {
			first.resolve(success())
			await pending
		}
		await expect(render(url, signal())).resolves.toMatchObject({
			html: '<article>Rendered</article>',
		})
		expect(fetch).toHaveBeenCalledTimes(3)
		second.resolve(success())
		await other
	})

	it('R5 defaults to at most three concurrent requests', async () => {
		const requests = Array.from({ length: 3 }, () => deferred<Response>())
		const fetch = vi.fn<typeof globalThis.fetch>()
		for (const request of requests) fetch.mockImplementationOnce(() => request.promise)
		const render = renderer(fetch)
		const pending = requests.map(() => render(url, signal()))
		await expectFailure(render(url, signal()), 'busy')
		expect(fetch).toHaveBeenCalledTimes(3)
		for (const request of requests) request.resolve(success())
		await Promise.all(pending)
	})

	it('R5 defaults to at most 200 started requests per hour', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => success())
		const render = createBrowserRenderer({
			accountId: 'account',
			apiToken: token,
			fetch,
			now: () => 0,
		})
		for (let call = 0; call < 200; call++) await render(url, signal())
		await expectFailure(render(url, signal()), 'busy')
		expect(fetch).toHaveBeenCalledTimes(200)
	})

	it('R5 applies a rolling hour to started calls including failures and recovers without extending rejected-call expiry', async () => {
		let now = 0
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new Error('network failed'))
			.mockImplementation(async () => success())
		const render = createBrowserRenderer({
			accountId: 'account',
			apiToken: token,
			fetch,
			maxPerHour: 2,
			now: () => now,
		})
		await expectFailure(render(url, signal()), 'failed')
		now = 30 * 60_000
		await render(url, signal())
		now = 60 * 60_000 - 1
		await expectFailure(render(url, signal()), 'busy')
		expect(fetch).toHaveBeenCalledTimes(2)
		now = 60 * 60_000 + 1
		await render(url, signal())
		await expectFailure(render(url, signal()), 'busy')
		expect(fetch).toHaveBeenCalledTimes(3)
		now = 90 * 60_000 + 1
		await render(url, signal())
		expect(fetch).toHaveBeenCalledTimes(4)
	})

	it.each([
		{},
		{ CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID: 'account' },
		{ CLOUDFLARE_BROWSER_RUN_API_TOKEN: token },
		{ CLOUDFLARE_BROWSER_RUN_API_TOKEN: ' \t', CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID: 'account' },
		{ CLOUDFLARE_BROWSER_RUN_API_TOKEN: token, CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID: ' \n' },
		{ CLOUDFLARE_BROWSER_RUN_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: ' ' },
	])('R6 disables rendering for missing or blank credentials %j', (env) => {
		expect(browserRendererFromEnv(env)).toBeNull()
	})

	it.each([
		{ CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID: 'specific' },
		{ CLOUDFLARE_ACCOUNT_ID: 'fallback' },
		{ CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID: 'specific', CLOUDFLARE_ACCOUNT_ID: 'fallback' },
	])('R6 constructs a renderer with valid account settings %j', (accounts) => {
		expect(
			browserRendererFromEnv({ ...accounts, CLOUDFLARE_BROWSER_RUN_API_TOKEN: token }),
		).toBeTypeOf('function')
	})

	it('R7 exports nonempty valid standalone JavaScript for CSSOM serialization', () => {
		expect(PAGE_SNAPSHOT_SCRIPT.trim().length).toBeGreaterThan(0)
		expect(() => new Function(PAGE_SNAPSHOT_SCRIPT)).not.toThrow()
	})
})
