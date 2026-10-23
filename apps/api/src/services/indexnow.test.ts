import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	affectedUrls,
	checkUrlTemplate,
	chunk,
	classifyIndexNowStatus,
	expandUrlTemplate,
	generateIndexNowKey,
	INDEXNOW_DEFAULT_ENDPOINT,
	INDEXNOW_MAX_ATTEMPTS,
	INDEXNOW_MAX_URLS_PER_REQUEST,
	keyFilePath,
	keyLocationFor,
	recordUrls,
	retryDelayMs,
	submitToIndexNow,
	validateIndexNowKey,
	verifyKeyFile,
} from './indexnow.js'

const validatePublicUrl = vi.hoisted(() => vi.fn(async () => null as string | null))
const safeFetch = vi.hoisted(() =>
	vi.fn((url: string, init?: RequestInit) => fetch(url, init) as Promise<Response>),
)
vi.mock('../adapters/connection-guard.js', () => ({
	validatePublicUrl,
	// IndexNow goes through safeFetch; hand it straight to the stubbed global
	// fetch so the tests keep observing the exact request it sends.
	safeFetch,
}))

const KEY = 'abcdef0123456789abcdef0123456789'

describe('constants', () => {
	it('exposes the documented limits and the default endpoint', () => {
		expect(INDEXNOW_MAX_URLS_PER_REQUEST).toBe(10_000)
		expect(INDEXNOW_MAX_ATTEMPTS).toBe(6)
		expect(INDEXNOW_DEFAULT_ENDPOINT).toBe('https://api.indexnow.org/indexnow')
	})
})

describe('generateIndexNowKey', () => {
	it('returns 32 lowercase hex characters, different on every call', () => {
		const keys = Array.from({ length: 25 }, () => generateIndexNowKey())
		for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/)
		expect(new Set(keys).size).toBe(keys.length)
	})
})

describe('validateIndexNowKey', () => {
	it.each([
		['8 characters (lower bound)', 'abcdefgh', true],
		['128 characters (upper bound)', 'a'.repeat(128), true],
		['letters, digits and dashes', 'abc-DEF-123', true],
		['a generated key', KEY, true],
		['7 characters', 'abcdefg', false],
		['129 characters', 'a'.repeat(129), false],
		['empty', '', false],
		['a space inside', 'abcd efgh', false],
		['an underscore', 'abcd_efgh', false],
		['a dot (file extension pasted in)', 'abcdefgh.txt', false],
		['a slash', 'abcd/efgh', false],
		['non-ASCII letters', 'ключключключ', false],
		['a newline', 'abcdefgh\n', false],
	])('%s', (_label, key, valid) => {
		const result = validateIndexNowKey(key)
		if (valid) {
			expect(result).toBeNull()
		} else {
			expect(typeof result).toBe('string')
			expect((result as string).length).toBeGreaterThan(0)
		}
	})
})

describe('checkUrlTemplate', () => {
	it.each([
		[
			'a plain template',
			'https://dashbird.pro/news/{slug}/',
			{ host: 'dashbird.pro', origin: 'https://dashbird.pro' },
		],
		[
			'surrounding whitespace and an upper-case host',
			'  https://Dashbird.pro/news/{slug}/\n',
			{ host: 'dashbird.pro', origin: 'https://dashbird.pro' },
		],
		[
			'a non-default port stays in the host',
			'http://example.com:8080/{id}',
			{ host: 'example.com:8080', origin: 'http://example.com:8080' },
		],
		[
			'a default port is dropped by URL.host',
			'https://example.com:443/{slug}',
			{ host: 'example.com', origin: 'https://example.com' },
		],
		[
			'locale and slug in the path',
			'https://example.com/{locale}/{slug}',
			{ host: 'example.com', origin: 'https://example.com' },
		],
		[
			'an {id}-only template',
			'https://example.com/p/{id}',
			{ host: 'example.com', origin: 'https://example.com' },
		],
		[
			'a placeholder in the query string',
			'https://example.com/post?slug={slug}',
			{ host: 'example.com', origin: 'https://example.com' },
		],
	])('accepts %s', (_label, template, expected) => {
		expect(checkUrlTemplate(template)).toEqual({ ok: true, ...expected })
	})

	it.each([
		['an empty template', ''],
		['a blank template', '   \n'],
		['a template longer than 2048 characters', `https://example.com/${'a'.repeat(2040)}/{slug}`],
		['an unknown placeholder', 'https://example.com/{title}/{slug}'],
		['a placeholder with inner spaces', 'https://example.com/{ slug }'],
		['an unknown placeholder next to a valid one', 'https://example.com/{slug}/{foo}'],
		['no {slug} or {id}', 'https://example.com/news/'],
		['only a {locale} placeholder', 'https://example.com/{locale}/'],
		['a non-http scheme', 'ftp://example.com/{slug}'],
		['a root-relative path', '/news/{slug}'],
		['a relative path', 'news/{slug}'],
		['a placeholder in the host', 'https://{locale}.example.com/{slug}'],
		['an {id} placeholder in the host', 'https://{id}.example.com/news'],
	])('rejects %s', (_label, template) => {
		const result = checkUrlTemplate(template)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(typeof result.error).toBe('string')
			expect(result.error.length).toBeGreaterThan(0)
		}
	})

	it.each([
		['https://example.com/{title}/{slug}', '{title}'],
		// spec: "the error names the token" = the error text contains the token as written, braces included
		['https://example.com/{ slug }', '{ slug }'],
	])('names the offending token in the error for %s', (template, token) => {
		const result = checkUrlTemplate(template)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toContain(token)
	})
})

describe('expandUrlTemplate', () => {
	const record = { id: 'rec-1', slug: 'hello', locale: 'en' }

	it.each([
		['a slug', 'https://x.com/news/{slug}/', record, 'https://x.com/news/hello/'],
		[
			'every occurrence of every placeholder',
			'https://x.com/{locale}/{slug}/{slug}?id={id}&again={id}&l={locale}',
			record,
			'https://x.com/en/hello/hello?id=rec-1&again=rec-1&l=en',
		],
		[
			'a path-like slug, each segment encoded',
			'https://x.com/{slug}',
			{ ...record, slug: 'docs/getting started' },
			'https://x.com/docs/getting%20started',
		],
		[
			'a path-like slug with several encoded segments',
			'https://x.com/{slug}',
			{ ...record, slug: 'a b/c d/e' },
			'https://x.com/a%20b/c%20d/e',
		],
		[
			'leading and trailing slashes stripped from the slug',
			'https://x.com/{slug}/',
			{ ...record, slug: '/docs/intro/' },
			'https://x.com/docs/intro/',
		],
		[
			'reserved characters in the slug',
			'https://x.com/{slug}',
			{ ...record, slug: 'a?b#c&d=e' },
			'https://x.com/a%3Fb%23c%26d%3De',
		],
		[
			'non-ASCII characters in the slug',
			'https://x.com/{slug}',
			{ ...record, slug: 'café-борщ' },
			`https://x.com/${encodeURIComponent('café-борщ')}`,
		],
		[
			'a locale',
			'https://x.com/{locale}/p',
			{ ...record, locale: 'pt-BR' },
			'https://x.com/pt-BR/p',
		],
		[
			'a locale that needs encoding',
			'https://x.com/{locale}/p/{id}',
			{ ...record, locale: 'en/GB' },
			'https://x.com/en%2FGB/p/rec-1',
		],
		[
			'an id that needs encoding',
			'https://x.com/p/{id}',
			{ ...record, id: 'a/b c' },
			'https://x.com/p/a%2Fb%20c',
		],
		[
			'an {id}-only template with a null slug',
			'https://x.com/p/{id}',
			{ ...record, slug: null },
			'https://x.com/p/rec-1',
		],
		[
			'an {id}-only template with an empty locale',
			'https://x.com/p/{id}',
			{ ...record, locale: '' },
			'https://x.com/p/rec-1',
		],
		[
			'a {slug}-only template with an empty locale and id',
			'https://x.com/{slug}',
			{ id: '', slug: 'hello', locale: '' },
			'https://x.com/hello',
		],
	])('expands %s', (_label, template, rec, expected) => {
		expect(expandUrlTemplate(template, rec)).toBe(expected)
	})

	it.each([
		['a null slug', 'https://x.com/{slug}', { ...record, slug: null }],
		['an empty slug', 'https://x.com/{slug}', { ...record, slug: '' }],
		['a slug of only slashes', 'https://x.com/{slug}', { ...record, slug: '///' }],
		[
			'a null slug when {slug} is combined with {id}',
			'https://x.com/{id}/{slug}',
			{ ...record, slug: null },
		],
		[
			'an empty locale when {locale} is used',
			'https://x.com/{locale}/{slug}',
			{ ...record, locale: '' },
		],
	])('returns null for %s', (_label, template, rec) => {
		expect(expandUrlTemplate(template, rec)).toBeNull()
	})
})

describe('recordUrls', () => {
	const rec = { id: 'rec-1', slug: 'hello', locale: 'uk' }
	const LOCALIZED = 'https://x.com/{locale}/news/{slug}'
	const PLAIN = 'https://x.com/news/{slug}'

	it.each([
		[
			'fans out over the project locales, in order, when the template has {locale} and localized is on',
			LOCALIZED,
			{ localized: true, projectLocales: ['en', 'uk', 'de'] },
			['https://x.com/en/news/hello', 'https://x.com/uk/news/hello', 'https://x.com/de/news/hello'],
		],
		[
			'keeps the project locale order even when it differs from the record locale',
			LOCALIZED,
			{ localized: true, projectLocales: ['de', 'uk'] },
			['https://x.com/de/news/hello', 'https://x.com/uk/news/hello'],
		],
		[
			'uses only the record locale when localized is off',
			LOCALIZED,
			{ localized: false, projectLocales: ['en', 'uk', 'de'] },
			['https://x.com/uk/news/hello'],
		],
		[
			'uses a single URL when the template has no {locale}, even if localized is on',
			PLAIN,
			{ localized: true, projectLocales: ['en', 'uk', 'de'] },
			['https://x.com/news/hello'],
		],
		[
			'uses a single URL for a plain template',
			PLAIN,
			{ localized: false, projectLocales: ['en'] },
			['https://x.com/news/hello'],
		],
		[
			'de-duplicates repeated locales, preserving first-seen order',
			LOCALIZED,
			{ localized: true, projectLocales: ['uk', 'en', 'uk'] },
			['https://x.com/uk/news/hello', 'https://x.com/en/news/hello'],
		],
		[
			'encodes each expanded locale',
			LOCALIZED,
			{ localized: true, projectLocales: ['en GB'] },
			['https://x.com/en%20GB/news/hello'],
		],
		[
			// spec decision: a project with no stored locales still has the record's own
			// page, so an empty list falls back to the record's locale
			'falls back to the record locale for an empty locale list',
			LOCALIZED,
			{ localized: true, projectLocales: [] },
			['https://x.com/uk/news/hello'],
		],
	])('%s', (_label, template, opts, expected) => {
		expect(recordUrls(template, rec, opts)).toEqual(expected)
	})

	it.each([
		[
			'a null slug with a {slug} template',
			PLAIN,
			{ ...rec, slug: null },
			{ localized: false, projectLocales: [] },
		],
		[
			'a null slug with a localized template',
			LOCALIZED,
			{ ...rec, slug: null },
			{ localized: true, projectLocales: ['en', 'uk'] },
		],
	])('drops null expansions: %s', (_label, template, record, opts) => {
		expect(recordUrls(template, record, opts)).toEqual([])
	})

	it('collapses an {id}-only template to one URL regardless of the locale fan-out', () => {
		// The template has no {locale}, so every locale expands to the same URL anyway.
		expect(
			recordUrls(
				'https://x.com/p/{id}',
				{ ...rec, slug: null },
				{ localized: true, projectLocales: ['en', 'uk'] },
			),
		).toEqual(['https://x.com/p/rec-1'])
	})
})

describe('affectedUrls', () => {
	const TEMPLATE = 'https://x.com/news/{slug}/'
	const LOCALIZED_TEMPLATE = 'https://x.com/{locale}/{slug}/'
	const state = (
		over: Partial<{ id: string; slug: string | null; locale: string; status: string }> = {},
	) => ({
		id: 'rec-1',
		slug: 'a',
		locale: 'en',
		status: 'draft',
		...over,
	})
	const opts = { localized: false, projectLocales: ['en'] }
	const urlA = 'https://x.com/news/a/'
	const urlB = 'https://x.com/news/b/'

	it.each([
		['publish (draft to published)', state(), state({ status: 'published' }), [urlA]],
		['create as published', null, state({ status: 'published' }), [urlA]],
		[
			'edit of a published record, in place, yields exactly one URL',
			state({ status: 'published' }),
			state({ status: 'published' }),
			[urlA],
		],
		['unpublish (published to draft)', state({ status: 'published' }), state(), [urlA]],
		['archive', state({ status: 'published' }), state({ status: 'archived' }), [urlA]],
		['delete of a published record', state({ status: 'published' }), null, [urlA]],
		[
			'published back to scheduled',
			state({ status: 'published' }),
			state({ status: 'scheduled' }),
			[urlA],
		],
		[
			'slug change while published: the new URL first, then the old one',
			state({ status: 'published' }),
			state({ status: 'published', slug: 'b' }),
			[urlB, urlA],
		],
		[
			'slug change together with an unpublish: only the old URL',
			state({ status: 'published' }),
			state({ slug: 'b' }),
			[urlA],
		],
		[
			'slug change together with a publish: only the new URL',
			state({ slug: 'a' }),
			state({ status: 'published', slug: 'b' }),
			[urlB],
		],
		[
			'a published record that lost its slug: only the old URL',
			state({ status: 'published' }),
			state({ status: 'published', slug: null }),
			[urlA],
		],
		['draft edit', state(), state(), []],
		['draft created', null, state(), []],
		['draft deleted', state(), null, []],
		['scheduling a draft', state(), state({ status: 'scheduled' }), []],
		['submit for review', state(), state({ status: 'pending_review' }), []],
		['reject back to draft', state({ status: 'pending_review' }), state(), []],
		['restore an archived record to draft', state({ status: 'archived' }), state(), []],
		['an archived record edited', state({ status: 'archived' }), state({ status: 'archived' }), []],
		['no before and no after', null, null, []],
	])('%s', (_label, before, after, expected) => {
		expect(affectedUrls(TEMPLATE, { before, after }, opts)).toEqual(expected)
	})

	it('covers every project locale for both the new and the old URL on a localized template', () => {
		const localized = { localized: true, projectLocales: ['en', 'uk'] }
		expect(
			affectedUrls(
				LOCALIZED_TEMPLATE,
				{
					before: state({ status: 'published' }),
					after: state({ status: 'published', slug: 'b' }),
				},
				localized,
			),
		).toEqual([
			'https://x.com/en/b/',
			'https://x.com/uk/b/',
			'https://x.com/en/a/',
			'https://x.com/uk/a/',
		])
		expect(
			affectedUrls(
				LOCALIZED_TEMPLATE,
				{ before: state(), after: state({ status: 'published' }) },
				localized,
			),
		).toEqual(['https://x.com/en/a/', 'https://x.com/uk/a/'])
	})

	it('reports the old locale URL when only the locale of a published record changes', () => {
		expect(
			affectedUrls(
				LOCALIZED_TEMPLATE,
				{
					before: state({ status: 'published', locale: 'en' }),
					after: state({ status: 'published', locale: 'uk' }),
				},
				{ localized: false, projectLocales: ['en', 'uk'] },
			),
		).toEqual(['https://x.com/uk/a/', 'https://x.com/en/a/'])
	})
})

describe('keyLocationFor', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['an empty string', ''],
	])('defaults to /<key>.txt on the host when keyLocation is %s', (_label, keyLocation) => {
		expect(keyLocationFor({ key: KEY, keyLocation }, 'dashbird.pro')).toBe(
			`https://dashbird.pro/${KEY}.txt`,
		)
	})

	it.each([
		['the same host', 'https://dashbird.pro/news/k.txt', 'dashbird.pro'],
		['the same host in another case', 'https://DASHBIRD.pro/news/k.txt', 'dashbird.pro'],
		['the same host and port', 'http://localhost:3000/news/k.txt', 'localhost:3000'],
		['the same host with a query', 'https://dashbird.pro/news/k.txt?v=1', 'dashbird.pro'],
	])('returns keyLocation unchanged for %s', (_label, keyLocation, host) => {
		expect(keyLocationFor({ key: 'k', keyLocation }, host)).toBe(new URL(keyLocation).toString())
	})

	it.each([
		[
			'the path moves to the other host',
			'https://a.com/news/k.txt',
			'b.com',
			'https://b.com/news/k.txt',
		],
		[
			'the query moves along',
			'https://a.com/news/k.txt?v=1',
			'b.com',
			'https://b.com/news/k.txt?v=1',
		],
		['the protocol is kept', 'http://a.com/k.txt', 'b.com', 'http://b.com/k.txt'],
		['the root path is kept', 'https://a.com/k.txt', 'b.com', 'https://b.com/k.txt'],
	])('re-hosts keyLocation on another host: %s', (_label, keyLocation, host, expected) => {
		expect(keyLocationFor({ key: 'k', keyLocation }, host)).toBe(expected)
	})
})

describe('keyFilePath', () => {
	it.each([
		['null keyLocation', null, `/${KEY}.txt`],
		['undefined keyLocation', undefined, `/${KEY}.txt`],
		['empty keyLocation', '', `/${KEY}.txt`],
		['a keyLocation under a prefix', 'https://a.com/news/k.txt', '/news/k.txt'],
		['a root keyLocation', 'https://a.com/k.txt', '/k.txt'],
		['a keyLocation with a query (pathname only)', 'https://a.com/news/k.txt?v=1', '/news/k.txt'],
	])('%s', (_label, keyLocation, expected) => {
		expect(keyFilePath({ key: KEY, keyLocation })).toBe(expected)
	})
})

describe('classifyIndexNowStatus', () => {
	it.each([
		[200, 'success'],
		[201, 'success'],
		[202, 'success'],
		[204, 'success'],
		[299, 'success'],
		[408, 'retry'],
		[429, 'retry'],
		[500, 'retry'],
		[502, 'retry'],
		[503, 'retry'],
		[504, 'retry'],
		[599, 'retry'],
		[400, 'fail'],
		[401, 'fail'],
		[403, 'fail'],
		[404, 'fail'],
		[410, 'fail'],
		[422, 'fail'],
		[451, 'fail'],
		// spec: "every other status" includes non-2xx, non-4xx-listed codes such as redirects
		[301, 'fail'],
	])('status %i is %s', (status, outcome) => {
		expect(classifyIndexNowStatus(status)).toBe(outcome)
	})
})

describe('retryDelayMs', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it.each([
		[1, 60_000],
		[2, 300_000],
		[3, 1_800_000],
		[4, 7_200_000],
		[5, 21_600_000],
		[6, 21_600_000],
		[12, 21_600_000],
	])('attempt %i without Retry-After waits %i ms', (attempt, expected) => {
		expect(retryDelayMs(attempt)).toBe(expected)
	})

	it.each([
		['integer seconds', '120', 120_000],
		['a long number of seconds', '3600', 3_600_000],
		['seconds below the floor are clamped up', '1', 60_000],
		['zero seconds is clamped up', '0', 60_000],
		['seconds above the ceiling are clamped down', '999999', 21_600_000],
	])('Retry-After %s', (_label, header, expected) => {
		expect(retryDelayMs(1, header)).toBe(expected)
	})

	it('lets a parseable Retry-After win over the attempt schedule, in both directions', () => {
		expect(retryDelayMs(4, '120')).toBe(120_000) // shorter than the 2 h schedule
		expect(retryDelayMs(1, '3600')).toBe(3_600_000) // longer than the 1 min schedule
	})

	it('reads an HTTP date relative to the given now', () => {
		const now = new Date('2026-01-01T00:00:00Z')
		expect(retryDelayMs(1, 'Thu, 01 Jan 2026 00:10:00 GMT', now)).toBe(600_000)
		expect(retryDelayMs(3, new Date(now.getTime() + 1_800_000 * 2).toUTCString(), now)).toBe(
			3_600_000,
		)
	})

	it('clamps an HTTP date in the past up to the floor and one far ahead down to the ceiling', () => {
		const now = new Date('2026-01-01T00:00:00Z')
		expect(retryDelayMs(1, 'Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(60_000)
		expect(retryDelayMs(1, 'Sat, 03 Jan 2026 00:00:00 GMT', now)).toBe(21_600_000)
	})

	it('defaults now to the current time', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		expect(retryDelayMs(1, 'Thu, 01 Jan 2026 00:05:00 GMT')).toBe(300_000)
	})

	it.each([
		['words', 'soon'],
		['a sentence', 'not a date at all'],
		['an empty string', ''],
		['null', null],
		['undefined', undefined],
	])('falls back to the attempt schedule for %s', (_label, header) => {
		expect(retryDelayMs(1, header)).toBe(60_000)
		expect(retryDelayMs(2, header)).toBe(300_000)
		expect(retryDelayMs(7, header)).toBe(21_600_000)
	})
})

describe('chunk', () => {
	it.each([
		['an empty list', [], 3, []],
		['a list shorter than the size', [1, 2], 5, [[1, 2]]],
		[
			'an exact multiple',
			[1, 2, 3, 4],
			2,
			[
				[1, 2],
				[3, 4],
			],
		],
		['a remainder in the last slice', [1, 2, 3, 4, 5], 2, [[1, 2], [3, 4], [5]]],
		['size 1', [1, 2, 3], 1, [[1], [2], [3]]],
	])('splits %s', (_label, items, size, expected) => {
		expect(chunk(items, size)).toEqual(expected)
	})

	it.each([
		[0, []],
		[1, [1]],
		[9_999, [9_999]],
		[10_000, [10_000]],
		[10_001, [10_000, 1]],
		[20_000, [10_000, 10_000]],
		[25_000, [10_000, 10_000, 5_000]],
	])('splits %i items at the IndexNow limit into slices of %j', (count, sizes) => {
		const items = Array.from({ length: count }, (_, i) => i)
		const slices = chunk(items, INDEXNOW_MAX_URLS_PER_REQUEST)
		expect(slices.map((s) => s.length)).toEqual(sizes)
		expect(slices.flat()).toEqual(items)
	})

	it('keeps order and does not mutate the input', () => {
		const items = ['a', 'b', 'c', 'd', 'e']
		const copy = [...items]
		expect(chunk(items, 2).flat()).toEqual(items)
		expect(items).toEqual(copy)
	})
})

describe('submitToIndexNow', () => {
	const URLS = ['https://dashbird.pro/news/a/', 'https://dashbird.pro/news/b/']
	const INPUT = {
		host: 'dashbird.pro',
		key: KEY,
		keyLocation: `https://dashbird.pro/news/${KEY}.txt`,
		urls: URLS,
	}
	let savedEndpoint: string | undefined

	function respond(status: number, body = '', headers: Record<string, string> = {}) {
		const fetchMock = vi.fn(async () => new Response(body, { status, headers }))
		vi.stubGlobal('fetch', fetchMock)
		return fetchMock
	}

	function sent(fetchMock: ReturnType<typeof respond>) {
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		return { url, init, body: JSON.parse(init.body as string) }
	}

	beforeEach(() => {
		savedEndpoint = process.env.INDEXNOW_ENDPOINT
		delete process.env.INDEXNOW_ENDPOINT
		safeFetch.mockClear()
		validatePublicUrl.mockReset()
		validatePublicUrl.mockResolvedValue(null)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		if (savedEndpoint === undefined) delete process.env.INDEXNOW_ENDPOINT
		else process.env.INDEXNOW_ENDPOINT = savedEndpoint
	})

	it('sends exactly one POST through safeFetch with the documented body and content type', async () => {
		const fetchMock = respond(200, 'OK')

		await submitToIndexNow(INPUT)

		expect(safeFetch).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const { url, init, body } = sent(fetchMock)
		expect(url).toBe(INDEXNOW_DEFAULT_ENDPOINT)
		expect(init.method).toBe('POST')
		expect(new Headers(init.headers).get('content-type')).toBe('application/json; charset=utf-8')
		expect(body).toEqual({
			host: 'dashbird.pro',
			key: KEY,
			keyLocation: `https://dashbird.pro/news/${KEY}.txt`,
			urlList: URLS,
		})
	})

	it('keeps the url order in urlList', async () => {
		const fetchMock = respond(200)
		const urls = ['https://h.com/3', 'https://h.com/1', 'https://h.com/2']

		await submitToIndexNow({ ...INPUT, host: 'h.com', urls })

		expect(sent(fetchMock).body.urlList).toEqual(urls)
	})

	it.each([
		[
			'the explicit option',
			'https://option.example/indexnow',
			'https://env.example/indexnow',
			'https://option.example/indexnow',
		],
		[
			'INDEXNOW_ENDPOINT when no option is given',
			undefined,
			'https://env.example/indexnow',
			'https://env.example/indexnow',
		],
		['the default endpoint when neither is set', undefined, undefined, INDEXNOW_DEFAULT_ENDPOINT],
	])('posts to %s', async (_label, endpoint, env, expected) => {
		if (env) process.env.INDEXNOW_ENDPOINT = env
		const fetchMock = respond(200)

		await submitToIndexNow(INPUT, endpoint ? { endpoint } : undefined)

		expect(sent(fetchMock).url).toBe(expected)
	})

	it.each([
		[200, 'success'],
		[202, 'success'],
		[408, 'retry'],
		[429, 'retry'],
		[503, 'retry'],
		[400, 'fail'],
		[403, 'fail'],
		[422, 'fail'],
	])('answers status %i with outcome %s and the status code', async (status, outcome) => {
		respond(status, 'body')

		const result = await submitToIndexNow(INPUT)

		expect(result.outcome).toBe(outcome)
		expect(result.statusCode).toBe(status)
	})

	it.each([
		['trims the response body', '  rate limited \n', 'rate limited'],
		['cuts a long body to 500 characters', 'x'.repeat(800), 'x'.repeat(500)],
		['cuts after trimming', `\n\n${'y'.repeat(700)}\n`, 'y'.repeat(500)],
	])('message %s', async (_label, body, expected) => {
		respond(422, body)

		expect((await submitToIndexNow(INPUT)).message).toBe(expected)
	})

	it.each([
		200, 422, 503,
	])('uses a non-empty default message for an empty %i body', async (status) => {
		respond(status, '')

		const { message } = await submitToIndexNow(INPUT)

		expect(typeof message).toBe('string')
		expect(message.trim().length).toBeGreaterThan(0)
	})

	it.each([
		['seconds', '120'],
		['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
	])('passes Retry-After (%s) through untouched', async (_label, header) => {
		respond(429, 'slow down', { 'Retry-After': header })

		const result = await submitToIndexNow(INPUT)

		expect(result.retryAfter).toBe(header)
	})

	it('reports a null retryAfter when the header is absent', async () => {
		respond(200)

		expect((await submitToIndexNow(INPUT)).retryAfter).toBeNull()
	})

	it('throws before any request when the url list is empty', async () => {
		const fetchMock = respond(200)

		await expect(submitToIndexNow({ ...INPUT, urls: [] })).rejects.toThrow()

		expect(fetchMock).not.toHaveBeenCalled()
		expect(safeFetch).not.toHaveBeenCalled()
	})

	it('throws before any request when the url list exceeds 10 000 entries', async () => {
		const fetchMock = respond(200)
		const urls = Array.from({ length: 10_001 }, (_, i) => `https://dashbird.pro/news/${i}/`)

		await expect(submitToIndexNow({ ...INPUT, urls })).rejects.toThrow()

		expect(fetchMock).not.toHaveBeenCalled()
		expect(safeFetch).not.toHaveBeenCalled()
	})

	it('accepts exactly 10 000 urls', async () => {
		const fetchMock = respond(200)
		const urls = Array.from({ length: 10_000 }, (_, i) => `https://dashbird.pro/news/${i}/`)

		await submitToIndexNow({ ...INPUT, urls })

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(sent(fetchMock).body.urlList).toHaveLength(10_000)
	})

	it.each([
		['a network error', new Error('connect ECONNREFUSED 1.2.3.4:443')],
		['a timeout', new Error('The operation was aborted due to timeout')],
		['a blocked host', new Error('URL resolves to a private address')],
	])('resolves to retry (never throws) on %s', async (_label, error) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw error
			}),
		)

		await expect(submitToIndexNow(INPUT)).resolves.toEqual({
			outcome: 'retry',
			statusCode: null,
			message: error.message,
			retryAfter: null,
		})
	})
})

describe('verifyKeyFile', () => {
	const URL_ = `https://dashbird.pro/news/${KEY}.txt`

	function serve(status: number, body = '') {
		const fetchMock = vi.fn(async () => new Response(body, { status }))
		vi.stubGlobal('fetch', fetchMock)
		return fetchMock
	}

	beforeEach(() => {
		safeFetch.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('GETs the url through safeFetch and accepts a body equal to the key', async () => {
		const fetchMock = serve(200, KEY)

		const result = await verifyKeyFile(URL_, KEY)

		expect(result).toMatchObject({ ok: true, statusCode: 200 })
		expect(typeof result.message).toBe('string')
		expect(safeFetch).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
		expect(url).toBe(URL_)
		expect(init?.method ?? 'GET').toBe('GET')
	})

	it.each([
		['a trailing newline', `${KEY}\n`],
		['CRLF line endings', `${KEY}\r\n`],
		['surrounding whitespace', `  \n${KEY}\t \n`],
		['a UTF-8 BOM', `﻿${KEY}`],
		['a BOM and whitespace', `﻿${KEY}\r\n`],
	])('accepts a key file with %s', async (_label, body) => {
		serve(200, body)

		expect(await verifyKeyFile(URL_, KEY)).toMatchObject({ ok: true, statusCode: 200 })
	})

	it.each([
		['a different key', 'ffffffffffffffffffffffffffffffff'],
		['the key plus extra text', `${KEY}-extra`],
		['extra text before the key', `key: ${KEY}`],
		['the key in a different case', KEY.toUpperCase()],
		['an HTML page mentioning the key', `<html><body>${KEY}</body></html>`],
		['an empty body', ''],
		['two lines', `${KEY}\n${KEY}`],
	])('rejects %s with status 200', async (_label, body) => {
		serve(200, body)

		const result = await verifyKeyFile(URL_, KEY)

		expect(result.ok).toBe(false)
		expect(result.statusCode).toBe(200)
		expect(typeof result.message).toBe('string')
	})

	it.each([
		404, 403, 500, 503,
	])('reports status %i in the message and the result', async (status) => {
		serve(status, 'not found page')

		const result = await verifyKeyFile(URL_, KEY)

		expect(result.ok).toBe(false)
		expect(result.statusCode).toBe(status)
		expect(result.message).toContain(String(status))
	})

	it('reports a failed request as not ok with a null status code and the error message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('getaddrinfo ENOTFOUND dashbird.pro')
			}),
		)

		// spec decision: the message carries the error plus which file failed, for the admin
		const result = await verifyKeyFile(URL_, KEY)
		expect(result).toMatchObject({ ok: false, statusCode: null })
		expect(result.message).toContain('getaddrinfo ENOTFOUND dashbird.pro')
	})
})
