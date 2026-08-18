import { describe, expect, it } from 'vitest'
import { createWebhookSchema, sanitizeWebhook, updateWebhookSchema } from './webhooks.js'

const row = {
	id: 'wh1',
	projectId: 'p1',
	url: 'https://example.com/hook',
	secret: 'super-secret-signing-key-0123456789',
	events: ['content:published'],
	headersEnc: { Authorization: 'base64-ciphertext', Accept: 'base64-ciphertext-2' },
	customPayload: '{"event_type": "blog-published"}',
	active: true,
}

describe('sanitizeWebhook', () => {
	it('never leaks the secret or encrypted header values', () => {
		const out = sanitizeWebhook(row)
		const serialized = JSON.stringify(out)
		expect(serialized).not.toContain('super-secret-signing-key-0123456789')
		expect(serialized).not.toContain('base64-ciphertext')
		expect(out).not.toHaveProperty('secret')
		expect(out).not.toHaveProperty('headersEnc')
	})

	it('surfaces header names and keeps the non-secret fields', () => {
		const out = sanitizeWebhook(row)
		expect(out.headerNames.sort()).toEqual(['Accept', 'Authorization'])
		expect(out).toMatchObject({
			id: 'wh1',
			url: row.url,
			customPayload: row.customPayload,
		})
	})

	it('returns an empty name list when no headers are configured', () => {
		expect(sanitizeWebhook({ ...row, headersEnc: null }).headerNames).toEqual([])
	})
})

describe('webhook input validation', () => {
	const base = { url: 'https://example.com/hook' }

	it('accepts well-formed headers and payload', () => {
		const parsed = createWebhookSchema.safeParse({
			...base,
			headers: { Authorization: 'Bearer tok', Accept: 'application/vnd.github+json' },
			customPayload:
				'{"event_type": "blog-published", "client_payload": {"slug": "{{data.slug}}"}}',
		})
		expect(parsed.success).toBe(true)
	})

	it('rejects forbidden header names, case-insensitively', () => {
		for (const name of ['X-Webhook-Signature', 'x-webhook-id', 'Host', 'content-length']) {
			const parsed = createWebhookSchema.safeParse({ ...base, headers: { [name]: 'v' } })
			expect(parsed.success).toBe(false)
		}
	})

	it('rejects header names outside the allowed charset', () => {
		const parsed = createWebhookSchema.safeParse({ ...base, headers: { 'bad name': 'v' } })
		expect(parsed.success).toBe(false)
	})

	it('caps header count and value length', () => {
		const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-Custom-${i}`, 'v']))
		expect(createWebhookSchema.safeParse({ ...base, headers: tooMany }).success).toBe(false)
		expect(
			createWebhookSchema.safeParse({ ...base, headers: { 'X-Big': 'v'.repeat(2049) } }).success,
		).toBe(false)
	})

	it('rejects a custom payload that is not a JSON object', () => {
		for (const payload of ['not json', '[1,2]', '"str"', '3']) {
			expect(createWebhookSchema.safeParse({ ...base, customPayload: payload }).success).toBe(false)
		}
	})

	it('rejects an oversized custom payload', () => {
		const big = JSON.stringify({ filler: 'x'.repeat(9000) })
		expect(createWebhookSchema.safeParse({ ...base, customPayload: big }).success).toBe(false)
	})

	it('lets updates clear headers and payload with null', () => {
		const parsed = updateWebhookSchema.safeParse({ headers: null, customPayload: null })
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.headers).toBeNull()
			expect(parsed.data.customPayload).toBeNull()
		}
	})
})
