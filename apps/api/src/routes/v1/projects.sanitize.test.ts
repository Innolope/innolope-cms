import type { projects } from '@innolope/db'
import { describe, expect, it } from 'vitest'
import { sanitizeProject } from './projects.js'

const baseProject = (settings: Record<string, unknown>) =>
	({
		id: 'p1',
		name: 'Test',
		slug: 'test',
		ownerId: 'u1',
		settings,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	}) as unknown as typeof projects.$inferSelect

describe('sanitizeProject cloudflare secrets', () => {
	it('strips apiToken and R2 keys, exposing only has* flags', () => {
		const out = sanitizeProject(
			baseProject({
				mediaAdapter: 'cloudflare',
				cloudflare: {
					accountId: 'acc',
					apiToken: 'secret-token',
					imagesAccountHash: 'hash',
					r2Bucket: 'bucket',
					r2AccessKeyId: 'key-id',
					r2SecretAccessKey: 'key-secret',
					r2Endpoint: 'https://r2.example.com',
				},
			}),
			'admin',
		)
		const cf = (out.settings as Record<string, unknown>).cloudflare as Record<string, unknown>
		expect(cf.apiToken).toBeUndefined()
		expect(cf.r2AccessKeyId).toBeUndefined()
		expect(cf.r2SecretAccessKey).toBeUndefined()
		expect(cf.hasApiToken).toBe(true)
		expect(cf.hasR2Credentials).toBe(true)
		expect(cf.accountId).toBe('acc')
		expect(cf.imagesAccountHash).toBe('hash')
		expect(cf.r2Bucket).toBe('bucket')
		expect(cf.r2Endpoint).toBe('https://r2.example.com')
		expect(JSON.stringify(out)).not.toContain('secret-token')
		expect(JSON.stringify(out)).not.toContain('key-secret')
	})

	it('reports has* flags as false when secrets are absent', () => {
		const out = sanitizeProject(
			baseProject({ cloudflare: { accountId: 'acc', r2AccessKeyId: 'key-only' } }),
			'viewer',
		)
		const cf = (out.settings as Record<string, unknown>).cloudflare as Record<string, unknown>
		expect(cf.hasApiToken).toBe(false)
		// An access key without its secret is not a usable credential pair.
		expect(cf.hasR2Credentials).toBe(false)
	})

	it('leaves projects without cloudflare settings untouched', () => {
		const out = sanitizeProject(baseProject({ mediaAdapter: 'local' }), 'owner')
		expect((out.settings as Record<string, unknown>).cloudflare).toBeUndefined()
	})
})
