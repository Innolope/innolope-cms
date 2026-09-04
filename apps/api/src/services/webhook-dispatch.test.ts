import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret } from '../lib/crypto.js'
import {
	dispatchDelivery,
	initWebhookDispatcher,
	renderPayloadTemplate,
} from './webhook-dispatch.js'

const validatePublicUrl = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock('../adapters/connection-guard.js', () => ({
	validatePublicUrl,
	// The dispatcher goes through safeFetch; hand it straight to the stubbed
	// global fetch so the tests keep observing the exact request it sends.
	safeFetch: (url: string, init?: RequestInit) => fetch(url, init),
}))

process.env.SSO_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const PAYLOAD = {
	type: 'content:published',
	data: { id: 'c1', slug: 'hello-world', projectId: 'p1' },
	timestamp: '2020-01-01T00:00:00.000Z',
}

const WEBHOOK = { id: 'wh1', url: 'https://example.com/hook', secret: 'shh'.repeat(11) }

/** Fake of the drizzle surface dispatchDelivery touches: update().set().where(). */
function fakeApp() {
	const updates: Array<Record<string, unknown>> = []
	const app = {
		db: {
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						updates.push(values)
					},
				}),
			}),
		},
		log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
	} as unknown as FastifyInstance
	return { app, updates }
}

function fetchOk(status = 200) {
	return vi.fn(async () => ({ ok: status < 400, status, text: async () => 'received' }))
}

function delivery(attempts = 0) {
	return { id: 'd1', payload: PAYLOAD as Record<string, unknown>, attempts }
}

describe('dispatchDelivery', () => {
	beforeEach(() => {
		validatePublicUrl.mockReset()
		validatePublicUrl.mockResolvedValue(null)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('sends the event envelope with built-in headers and a signature over the sent body', async () => {
		const fetchMock = fetchOk()
		vi.stubGlobal('fetch', fetchMock)
		const { app, updates } = fakeApp()

		await dispatchDelivery(app, WEBHOOK, delivery())

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		const body = JSON.stringify(PAYLOAD)
		expect(url).toBe(WEBHOOK.url)
		expect(init.body).toBe(body)
		expect(init.headers).toMatchObject({
			'Content-Type': 'application/json',
			'X-Webhook-Id': 'wh1',
			'X-Webhook-Signature': createHmac('sha256', WEBHOOK.secret).update(body).digest('hex'),
		})
		expect(updates[0]).toMatchObject({
			status: 'success',
			statusCode: 200,
			sentBody: body,
			attempts: 1,
			nextRetry: null,
		})
	})

	it('decrypts custom headers onto the request', async () => {
		const fetchMock = fetchOk()
		vi.stubGlobal('fetch', fetchMock)
		const { app } = fakeApp()

		await dispatchDelivery(
			app,
			{ ...WEBHOOK, headersEnc: { Authorization: encryptSecret('Bearer tok-123') } },
			delivery(),
		)

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-123' })
	})

	it('lets custom headers override Content-Type but never the signature or id', async () => {
		const fetchMock = fetchOk()
		vi.stubGlobal('fetch', fetchMock)
		const { app } = fakeApp()

		await dispatchDelivery(
			app,
			{
				...WEBHOOK,
				headersEnc: {
					'Content-Type': encryptSecret('application/vnd.github+json'),
					'X-Webhook-Signature': encryptSecret('forged'),
					'X-Webhook-Id': encryptSecret('forged'),
				},
			},
			delivery(),
		)

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		const headers = init.headers as Record<string, string>
		expect(headers['Content-Type']).toBe('application/vnd.github+json')
		expect(headers['X-Webhook-Id']).toBe('wh1')
		expect(headers['X-Webhook-Signature']).toMatch(/^[0-9a-f]{64}$/)
	})

	it('renders a custom payload and signs the rendered body', async () => {
		const fetchMock = fetchOk(204)
		vi.stubGlobal('fetch', fetchMock)
		const { app, updates } = fakeApp()

		await dispatchDelivery(
			app,
			{
				...WEBHOOK,
				customPayload:
					'{"event_type": "blog-published", "client_payload": {"slug": "{{data.slug}}"}}',
			},
			delivery(),
		)

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(JSON.parse(init.body as string)).toEqual({
			event_type: 'blog-published',
			client_payload: { slug: 'hello-world' },
		})
		const headers = init.headers as Record<string, string>
		expect(headers['X-Webhook-Signature']).toBe(
			createHmac('sha256', WEBHOOK.secret)
				.update(init.body as string)
				.digest('hex'),
		)
		expect(updates[0]).toMatchObject({ status: 'success', sentBody: init.body })
	})

	it('fails without retry on a corrupt template and never fetches', async () => {
		const fetchMock = fetchOk()
		vi.stubGlobal('fetch', fetchMock)
		const { app, updates } = fakeApp()

		await dispatchDelivery(app, { ...WEBHOOK, customPayload: 'not json' }, delivery())

		expect(fetchMock).not.toHaveBeenCalled()
		expect(updates[0]).toMatchObject({
			status: 'failed',
			responseBody: 'Invalid custom payload template',
			nextRetry: null,
		})
	})

	it('fails with a retry when custom headers cannot be decrypted', async () => {
		const fetchMock = fetchOk()
		vi.stubGlobal('fetch', fetchMock)
		const { app, updates } = fakeApp()

		await dispatchDelivery(app, { ...WEBHOOK, headersEnc: { Authorization: 'AAAA' } }, delivery())

		expect(fetchMock).not.toHaveBeenCalled()
		expect(updates[0]).toMatchObject({ status: 'failed' })
		expect(updates[0].responseBody).toMatch(/decrypt/i)
		expect(updates[0].nextRetry).toBeInstanceOf(Date)
	})

	it('fails without retry when the URL no longer resolves publicly', async () => {
		validatePublicUrl.mockResolvedValue('URL resolves to a private address')
		const fetchMock = fetchOk()
		vi.stubGlobal('fetch', fetchMock)
		const { app, updates } = fakeApp()

		await dispatchDelivery(app, WEBHOOK, delivery())

		expect(fetchMock).not.toHaveBeenCalled()
		expect(updates[0]).toMatchObject({
			status: 'failed',
			responseBody: 'URL resolves to a private address',
			nextRetry: null,
		})
	})

	it('schedules a retry on connection failure, unless retry is disabled', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNREFUSED')
			}),
		)
		const { app, updates } = fakeApp()

		await dispatchDelivery(app, WEBHOOK, delivery())
		expect(updates[0]).toMatchObject({ status: 'failed', responseBody: 'Connection failed' })
		expect(updates[0].nextRetry).toBeInstanceOf(Date)

		await dispatchDelivery(app, WEBHOOK, delivery(), { retry: false })
		expect(updates[1]).toMatchObject({ status: 'failed', nextRetry: null })
	})

	it('gives up after the third attempt', async () => {
		vi.stubGlobal('fetch', fetchOk(500))
		const { app, updates } = fakeApp()

		await dispatchDelivery(app, WEBHOOK, delivery(2))

		expect(updates[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetry: null })
	})
})

describe('renderPayloadTemplate', () => {
	it('passes a static template through untouched', () => {
		const template = '{"event_type": "blog-published"}'
		expect(JSON.parse(renderPayloadTemplate(template, PAYLOAD))).toEqual({
			event_type: 'blog-published',
		})
	})

	it('substitutes event, timestamp and data paths inside string values', () => {
		const out = JSON.parse(
			renderPayloadTemplate(
				'{"e": "{{event}}", "at": "{{timestamp}}", "slug": "slug={{ data.slug }}"}',
				PAYLOAD,
			),
		)
		expect(out).toEqual({
			e: 'content:published',
			at: '2020-01-01T00:00:00.000Z',
			slug: 'slug=hello-world',
		})
	})

	it('resolves nested data paths and leaves non-string values untouched', () => {
		const payload = { ...PAYLOAD, data: { ...PAYLOAD.data, meta: { title: 'Hi' } } }
		const out = JSON.parse(
			renderPayloadTemplate(
				'{"title": "{{data.meta.title}}", "n": 42, "ok": true, "list": ["{{event}}"]}',
				payload,
			),
		)
		expect(out).toEqual({ title: 'Hi', n: 42, ok: true, list: ['content:published'] })
	})

	it('renders unresolved placeholders as empty strings', () => {
		expect(JSON.parse(renderPayloadTemplate('{"x": "{{data.missing.deep}}"}', PAYLOAD))).toEqual({
			x: '',
		})
	})

	it('keeps malicious values inside their JSON string', () => {
		const payload = { ...PAYLOAD, data: { ...PAYLOAD.data, slug: '","evil":"1' } }
		const out = JSON.parse(renderPayloadTemplate('{"slug": "{{data.slug}}"}', payload))
		expect(out).toEqual({ slug: '","evil":"1' })
	})

	it('rejects templates that are not JSON objects', () => {
		expect(() => renderPayloadTemplate('not json', PAYLOAD)).toThrow(/template/i)
		expect(() => renderPayloadTemplate('[1,2]', PAYLOAD)).toThrow(/template/i)
		expect(() => renderPayloadTemplate('"str"', PAYLOAD)).toThrow(/template/i)
	})
})

describe('initWebhookDispatcher subscription', () => {
	function fakeSubscriberApp(webhookRows: Array<Record<string, unknown>>) {
		let listener: ((event: Record<string, unknown>) => Promise<void>) | undefined
		const inserted: Array<Record<string, unknown>> = []
		const app = {
			db: {
				select: () => ({ from: () => ({ where: async () => webhookRows }) }),
				insert: () => ({
					values: (values: Record<string, unknown>) => ({
						returning: async () => {
							inserted.push(values)
							return [{ id: 'd1', payload: values.payload, attempts: 0 }]
						},
					}),
				}),
				update: () => ({ set: () => ({ where: async () => {} }) }),
			},
			log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
			events: {
				subscribe: (fn: (event: Record<string, unknown>) => Promise<void>) => {
					listener = fn
					return () => {}
				},
			},
			addHook: vi.fn(),
		} as unknown as FastifyInstance
		initWebhookDispatcher(app)
		if (!listener) throw new Error('dispatcher did not subscribe')
		return { emit: listener, inserted }
	}

	beforeEach(() => {
		validatePublicUrl.mockReset()
		validatePublicUrl.mockResolvedValue(null)
		vi.stubGlobal('fetch', fetchOk())
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('drops events without a projectId', async () => {
		const { emit, inserted } = fakeSubscriberApp([{ ...WEBHOOK, events: [], active: true }])
		await emit({ type: 'content:published', data: {}, timestamp: 'now' })
		expect(inserted).toHaveLength(0)
	})

	it('skips webhooks not subscribed to the event type', async () => {
		const { emit, inserted } = fakeSubscriberApp([
			{ ...WEBHOOK, events: ['media:uploaded'], active: true },
		])
		await emit({ type: 'content:published', data: { projectId: 'p1' }, timestamp: 'now' })
		expect(inserted).toHaveLength(0)
	})

	it('creates a delivery for matching webhooks', async () => {
		const { emit, inserted } = fakeSubscriberApp([
			{ ...WEBHOOK, events: ['content:published'], active: true },
		])
		await emit({ type: 'content:published', data: { projectId: 'p1' }, timestamp: 'now' })
		expect(inserted).toHaveLength(1)
		expect(inserted[0]).toMatchObject({ webhookId: 'wh1', event: 'content:published' })
	})
})
