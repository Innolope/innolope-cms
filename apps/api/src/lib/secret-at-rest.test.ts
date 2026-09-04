import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { revealSecret, sealProjectSettings, sealSecret } from './secret-at-rest.js'

describe('secret-at-rest', () => {
	const prev = process.env.INTEGRATION_ENCRYPTION_KEY
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64')
	})
	afterEach(() => {
		if (prev === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY
		else process.env.INTEGRATION_ENCRYPTION_KEY = prev
	})

	it('round-trips and never double-seals', () => {
		const sealed = sealSecret('cf-token') as string
		expect(sealed.startsWith('enc:v1:')).toBe(true)
		expect(sealed).not.toContain('cf-token')
		expect(revealSecret(sealed)).toBe('cf-token')
		expect(sealSecret(sealed)).toBe(sealed)
	})

	it('passes legacy plaintext through on read', () => {
		expect(revealSecret('plain')).toBe('plain')
		expect(revealSecret(undefined)).toBeUndefined()
	})

	it('seals every secret-bearing settings field', () => {
		const out = sealProjectSettings({
			cloudflare: { accountId: 'a', apiToken: 't', r2SecretAccessKey: 's' },
			covers: { templateUrl: 'https://x', templateToken: 'tt' },
			externalDb: {
				connectionString: 'postgres://u:p@h/db',
				mediaStorage: {
					pics: { adapter: 'cloudflare-images', credentials: { apiToken: 'mt', accountHash: 'h' } },
				},
			},
		})
		const cf = out.cloudflare as Record<string, string>
		expect(cf.apiToken.startsWith('enc:v1:')).toBe(true)
		expect(cf.r2SecretAccessKey.startsWith('enc:v1:')).toBe(true)
		expect(cf.accountId).toBe('a')
		expect((out.covers as Record<string, string>).templateToken.startsWith('enc:v1:')).toBe(true)
		const creds = (
			(out.externalDb as Record<string, unknown>).mediaStorage as Record<
				string,
				{ credentials: Record<string, string> }
			>
		).pics.credentials
		expect(creds.apiToken.startsWith('enc:v1:')).toBe(true)
		expect(creds.accountHash).toBe('h')
	})
})
