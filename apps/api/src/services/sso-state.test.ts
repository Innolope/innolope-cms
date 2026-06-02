import { beforeAll, describe, expect, it } from 'vitest'
import { newNonce, sanitizeNext, signState, verifyState } from './sso-state.js'

beforeAll(() => {
	process.env.AUTH_SECRET = 'test-secret-at-least-32-characters-long'
})

describe('sanitizeNext (open-redirect guard)', () => {
	it('allows same-origin absolute paths', () => {
		expect(sanitizeNext('/dashboard')).toBe('/dashboard')
		expect(sanitizeNext('/a/b?x=1#h')).toBe('/a/b?x=1#h')
	})

	it('rejects empty / missing values', () => {
		expect(sanitizeNext(undefined)).toBeUndefined()
		expect(sanitizeNext(null)).toBeUndefined()
		expect(sanitizeNext('')).toBeUndefined()
	})

	it('rejects external and protocol-relative URLs', () => {
		expect(sanitizeNext('https://evil.com')).toBeUndefined()
		expect(sanitizeNext('//evil.com')).toBeUndefined()
		expect(sanitizeNext('evil.com')).toBeUndefined()
	})

	it('rejects backslash tricks', () => {
		expect(sanitizeNext('/\\evil.com')).toBeUndefined()
	})
})

describe('newNonce', () => {
	it('produces unique url-safe tokens', () => {
		const a = newNonce()
		const b = newNonce()
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
		expect(a).not.toBe(b)
	})
})

describe('signState / verifyState round-trip', () => {
	const payload = {
		slug: 'acme',
		connectionId: 'conn-1',
		nonce: 'n1',
		intent: 'login' as const,
	}

	it('verifies a freshly signed state back to its payload', async () => {
		const token = await signState(payload)
		const decoded = await verifyState(token)
		expect(decoded?.slug).toBe('acme')
		expect(decoded?.connectionId).toBe('conn-1')
		expect(decoded?.intent).toBe('login')
	})

	it('returns null for tampered or garbage tokens', async () => {
		const token = await signState(payload)
		expect(await verifyState(`${token.slice(0, -2)}xx`)).toBeNull()
		expect(await verifyState('not.a.jwt')).toBeNull()
	})
})
