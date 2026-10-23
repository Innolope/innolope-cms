import { randomBytes } from 'node:crypto'
import { safeFetch } from '../adapters/connection-guard.js'

/**
 * IndexNow (https://www.indexnow.org) — telling search engines which public URLs
 * changed. This module is the protocol and the URL arithmetic; the queue that
 * feeds it from content events lives in `indexnow-queue.ts`.
 */

/** The protocol's ceiling for one request. */
export const INDEXNOW_MAX_URLS_PER_REQUEST = 10_000
/** Failed attempts (429/5xx/network) after which a batch is given up. */
export const INDEXNOW_MAX_ATTEMPTS = 6
export const INDEXNOW_DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow'

const USER_AGENT = 'InnolopeCMS-IndexNow/1.0 (+https://innolope.com)'
const PLACEHOLDERS = new Set(['{slug}', '{locale}', '{id}'])
const MAX_TEMPLATE_LENGTH = 2048
const RETRY_SCHEDULE_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]
const MIN_RETRY_MS = RETRY_SCHEDULE_MS[0]
const MAX_RETRY_MS = RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1]

export interface IndexNowKeySettings {
	key: string
	keyLocation?: string | null
}

export function generateIndexNowKey(): string {
	return randomBytes(16).toString('hex')
}

/** The protocol allows 8–128 characters of letters, digits and dashes. */
export function validateIndexNowKey(key: string): string | null {
	if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(key)) {
		return 'The IndexNow key must be 8–128 characters of letters, digits and dashes.'
	}
	return null
}

export type UrlTemplateCheck =
	| { ok: true; host: string; origin: string }
	| { ok: false; error: string }

/**
 * A collection's public URL template, e.g. `https://example.com/blog/{slug}/`.
 * The host must be literal: IndexNow submits per host, and the host is what the
 * outbound URL guard screens, so it has to be known without a record.
 */
export function checkUrlTemplate(template: string): UrlTemplateCheck {
	const value = typeof template === 'string' ? template.trim() : ''
	if (!value) return { ok: false, error: 'The URL template is empty.' }
	if (value.length > MAX_TEMPLATE_LENGTH) {
		return {
			ok: false,
			error: `The URL template is longer than ${MAX_TEMPLATE_LENGTH} characters.`,
		}
	}
	for (const token of value.match(/\{[^}]*\}/g) ?? []) {
		if (!PLACEHOLDERS.has(token)) {
			return {
				ok: false,
				error: `Unknown placeholder ${token} in the URL template. Use {slug}, {locale} or {id}.`,
			}
		}
	}
	if (!value.includes('{slug}') && !value.includes('{id}')) {
		return {
			ok: false,
			error: 'The URL template needs {slug} or {id}, otherwise every record would share one URL.',
		}
	}
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1]
	if (authority?.includes('{')) {
		return { ok: false, error: 'The host of the URL template cannot contain a placeholder.' }
	}
	let parsed: URL
	try {
		parsed = new URL(
			value.replaceAll('{slug}', 'slug').replaceAll('{locale}', 'en').replaceAll('{id}', 'id'),
		)
	} catch {
		return {
			ok: false,
			error: 'The URL template must be an absolute URL such as https://example.com/blog/{slug}/.',
		}
	}
	if (!authority || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
		return { ok: false, error: 'The URL template must start with https:// or http://.' }
	}
	return { ok: true, host: parsed.host.toLowerCase(), origin: parsed.origin }
}

/**
 * One record's public URL, or null when the template needs a value the record
 * lacks (a record without a slug has no `{slug}` page). Slashes in a slug are
 * kept as path separators; every segment is percent-encoded.
 */
export function expandUrlTemplate(
	template: string,
	record: { id: string; slug: string | null; locale: string },
): string | null {
	let url = template.trim()
	if (url.includes('{slug}')) {
		const slug = (record.slug ?? '').replace(/^\/+|\/+$/g, '')
		if (!slug) return null
		url = url.replaceAll('{slug}', slug.split('/').map(encodeURIComponent).join('/'))
	}
	if (url.includes('{locale}')) {
		if (!record.locale) return null
		url = url.replaceAll('{locale}', encodeURIComponent(record.locale))
	}
	if (url.includes('{id}')) url = url.replaceAll('{id}', encodeURIComponent(record.id))
	return url
}

/**
 * Every public URL of one record. A collection with translatable fields keeps
 * all languages in one record, so a `{locale}` template yields one page per
 * project locale; otherwise the record is a single page in its own locale.
 */
export function recordUrls(
	template: string,
	record: { id: string; slug: string | null; locale: string },
	opts: { localized: boolean; projectLocales: string[] },
): string[] {
	const locales =
		template.includes('{locale}') && opts.localized && opts.projectLocales.length > 0
			? opts.projectLocales
			: [record.locale]
	const urls = locales
		.map((locale) => expandUrlTemplate(template, { ...record, locale }))
		.filter((url): url is string => url !== null)
	return [...new Set(urls)]
}

export interface UrlState {
	id: string
	slug: string | null
	locale: string
	status: string
}

/**
 * The URLs a write changed on the public site: the page as it is now when the
 * record is published, and the page as it was when it used to be (so engines
 * recrawl an unpublished, archived, deleted or moved page and see it gone).
 * Writes that never touch a published state change nothing public.
 */
export function affectedUrls(
	template: string,
	change: { before: UrlState | null; after: UrlState | null },
	opts: { localized: boolean; projectLocales: string[] },
): string[] {
	const urls: string[] = []
	if (change.after?.status === 'published') urls.push(...recordUrls(template, change.after, opts))
	if (change.before?.status === 'published') urls.push(...recordUrls(template, change.before, opts))
	return [...new Set(urls)]
}

/**
 * The key file URL to send for a host. The configured location is used as is
 * on its own host; another host is expected to serve the file at the same path.
 */
export function keyLocationFor(settings: IndexNowKeySettings, host: string): string {
	if (!settings.keyLocation) return `https://${host}/${settings.key}.txt`
	const location = new URL(settings.keyLocation)
	if (location.host.toLowerCase() === host.toLowerCase()) return location.toString()
	return `${location.protocol}//${host}${location.pathname}${location.search}`
}

/** Path of the key file on the site, for a site builder that writes it. */
export function keyFilePath(settings: IndexNowKeySettings): string {
	return settings.keyLocation ? new URL(settings.keyLocation).pathname : `/${settings.key}.txt`
}

export type SubmitOutcome = 'success' | 'retry' | 'fail'

/**
 * 200 means submitted, 202 means received with the key still being validated.
 * 429 and server errors are transient. Everything else (400 bad request, 403
 * key not valid, 422 URLs not on the host) needs a settings fix, not a retry.
 */
export function classifyIndexNowStatus(status: number): SubmitOutcome {
	if (status >= 200 && status < 300) return 'success'
	if (status === 408 || status === 429 || status >= 500) return 'retry'
	return 'fail'
}

/** Backoff before the next attempt, honouring the endpoint's `Retry-After`. */
export function retryDelayMs(
	attempt: number,
	retryAfter?: string | null,
	now = new Date(),
): number {
	const base = RETRY_SCHEDULE_MS[Math.min(Math.max(attempt, 1), RETRY_SCHEDULE_MS.length) - 1]
	const header = retryAfter?.trim()
	if (!header) return base
	let requested: number | null = null
	if (/^\d+$/.test(header)) requested = Number(header) * 1000
	else {
		const date = Date.parse(header)
		if (!Number.isNaN(date)) requested = date - now.getTime()
	}
	if (requested === null) return base
	return Math.min(Math.max(requested, MIN_RETRY_MS), MAX_RETRY_MS)
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
	return chunks
}

const DEFAULT_MESSAGES: Record<number, string> = {
	200: 'OK — URLs submitted.',
	202: 'Accepted — the key is still being validated.',
	400: 'Bad request — invalid format.',
	403: 'Forbidden — the key is not valid (key file not found, or its content does not match).',
	422: 'Unprocessable — the URLs do not belong to the host, or the key does not match the protocol.',
	429: 'Too many requests.',
}

export interface SubmitResult {
	outcome: SubmitOutcome
	statusCode: number | null
	message: string
	retryAfter: string | null
}

/** One IndexNow request. Never throws for a network failure: that is a retry. */
export async function submitToIndexNow(
	input: { host: string; key: string; keyLocation: string; urls: string[] },
	opts: { endpoint?: string; timeoutMs?: number } = {},
): Promise<SubmitResult> {
	if (input.urls.length === 0) throw new Error('submitToIndexNow needs at least one URL')
	if (input.urls.length > INDEXNOW_MAX_URLS_PER_REQUEST) {
		throw new Error(`submitToIndexNow takes at most ${INDEXNOW_MAX_URLS_PER_REQUEST} URLs`)
	}
	const endpoint = opts.endpoint ?? process.env.INDEXNOW_ENDPOINT ?? INDEXNOW_DEFAULT_ENDPOINT
	try {
		const response = await safeFetch(
			endpoint,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': USER_AGENT },
				body: JSON.stringify({
					host: input.host,
					key: input.key,
					keyLocation: input.keyLocation,
					urlList: input.urls,
				}),
				signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
			},
			{ maxRedirects: 0 },
		)
		const body = (await response.text().catch(() => '')).trim().slice(0, 500)
		return {
			outcome: classifyIndexNowStatus(response.status),
			statusCode: response.status,
			message: body || DEFAULT_MESSAGES[response.status] || `HTTP ${response.status}`,
			retryAfter: response.headers?.get?.('retry-after') ?? null,
		}
	} catch (err) {
		return {
			outcome: 'retry',
			statusCode: null,
			message: err instanceof Error ? err.message : String(err),
			retryAfter: null,
		}
	}
}

/**
 * Fetch the key file the way a search engine will, before any URL is submitted:
 * a missing file makes IndexNow answer 403 and drop the batch, while holding the
 * batch until the site serves the file loses nothing.
 */
export async function verifyKeyFile(
	url: string,
	key: string,
): Promise<{ ok: boolean; statusCode: number | null; message: string }> {
	try {
		const response = await safeFetch(
			url,
			{ method: 'GET', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) },
			{ maxRedirects: 3 },
		)
		if (!response.ok) {
			await response.body?.cancel().catch(() => {})
			return {
				ok: false,
				statusCode: response.status,
				message: `The key file at ${url} answered HTTP ${response.status}.`,
			}
		}
		const body = (await response.text()).slice(0, 1024).replace(/^﻿/, '').trim()
		if (body !== key) {
			return {
				ok: false,
				statusCode: response.status,
				message: `The key file at ${url} does not contain the key.`,
			}
		}
		return { ok: true, statusCode: response.status, message: `The key file at ${url} is valid.` }
	} catch (err) {
		return {
			ok: false,
			statusCode: null,
			message: `The key file at ${url} could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}
