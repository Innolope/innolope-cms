import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeLicenseKey, evaluateLicense, verifySignature } from './license.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

function sign(payloadStr: string): string {
	return createSign('SHA256').update(payloadStr).sign(privateKey, 'base64')
}

function makeLicenseKey(payloadStr: string, signature: string): string {
	const inner = JSON.stringify({ payload: payloadStr, signature })
	return `ink-lic_${Buffer.from(inner).toString('base64')}`
}

const samplePayload = JSON.stringify({
	org: 'Acme',
	email: 'a@acme.com',
	plan: 'enterprise',
	features: ['sso'],
	maxProjects: -1,
	expiresAt: '2099-01-01T00:00:00Z',
	issuedAt: '2024-01-01T00:00:00Z',
})

describe('decodeLicenseKey', () => {
	it('decodes a well-formed key and preserves the raw payload string', () => {
		const key = makeLicenseKey(samplePayload, sign(samplePayload))
		const decoded = decodeLicenseKey(key)
		expect(decoded).not.toBeNull()
		expect(decoded?.payloadStr).toBe(samplePayload)
		expect(decoded?.payload.org).toBe('Acme')
	})

	it('returns null for garbage input', () => {
		expect(decodeLicenseKey('not-a-license')).toBeNull()
		expect(decodeLicenseKey('ink-lic_!!!!')).toBeNull()
	})
})

describe('verifySignature', () => {
	it('accepts a signature produced by the matching private key', () => {
		expect(verifySignature(samplePayload, sign(samplePayload), publicKeyPem)).toBe(true)
	})

	it('rejects a forged signature (license bypass is closed)', () => {
		expect(verifySignature(samplePayload, 'forged-signature', publicKeyPem)).toBe(false)
	})

	it('rejects a valid signature over different content', () => {
		const tampered = samplePayload.replace('enterprise', 'community')
		expect(verifySignature(tampered, sign(samplePayload), publicKeyPem)).toBe(false)
	})

	it('rejects a signature from an unrelated key pair', () => {
		const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
		const otherSig = createSign('SHA256').update(samplePayload).sign(other.privateKey, 'base64')
		expect(verifySignature(samplePayload, otherSig, publicKeyPem)).toBe(false)
	})

	it('returns false when verified against the placeholder public key', () => {
		// Default key in this build is the community placeholder — it cannot validate anything.
		expect(verifySignature(samplePayload, sign(samplePayload))).toBe(false)
	})
})

describe('evaluateLicense', () => {
	it('treats a missing key as community tier with no error', () => {
		expect(evaluateLicense(undefined)).toEqual({ valid: false, payload: null })
		expect(evaluateLicense(null)).toEqual({ valid: false, payload: null })
		expect(evaluateLicense('')).toEqual({ valid: false, payload: null })
	})

	it('rejects a malformed key with a specific error', () => {
		const result = evaluateLicense('not-a-license')
		expect(result.valid).toBe(false)
		expect(result.error).toBe('Invalid license key format.')
	})

	it('rejects a well-formed key when the build has no real public key', () => {
		// This (community) build ships the placeholder public key, so even a
		// structurally valid key cannot be trusted and must not grant features.
		const key = makeLicenseKey(samplePayload, sign(samplePayload))
		const result = evaluateLicense(key)
		expect(result.valid).toBe(false)
		expect(result.error).toContain('no license public key')
	})
})
