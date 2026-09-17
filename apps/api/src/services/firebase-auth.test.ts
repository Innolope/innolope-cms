import { afterEach, describe, expect, it, vi } from 'vitest'

const originalConfig = process.env.FIREBASE_WEB_CONFIG

afterEach(() => {
	if (originalConfig === undefined) delete process.env.FIREBASE_WEB_CONFIG
	else process.env.FIREBASE_WEB_CONFIG = originalConfig
	vi.resetModules()
})

describe('firebaseWebConfig', () => {
	it('returns the public Firebase web config when all required fields are valid', async () => {
		process.env.FIREBASE_WEB_CONFIG = JSON.stringify({
			apiKey: 'public-api-key',
			authDomain: 'demo.firebaseapp.com',
			projectId: 'demo',
			appId: '1:123:web:abc',
			privateKey: 'must-not-be-exposed',
		})
		const { firebaseWebConfig } = await import('./firebase-auth.js')

		expect(firebaseWebConfig()).toEqual({
			apiKey: 'public-api-key',
			authDomain: 'demo.firebaseapp.com',
			projectId: 'demo',
			appId: '1:123:web:abc',
		})
	})

	it.each([
		undefined,
		'not-json',
		JSON.stringify({ apiKey: 'key' }),
		JSON.stringify({
			apiKey: 'key',
			authDomain: 'not a hostname',
			projectId: 'demo',
			appId: 'app',
		}),
	])('keeps Google login disabled for incomplete or invalid config', async (config) => {
		if (config === undefined) delete process.env.FIREBASE_WEB_CONFIG
		else process.env.FIREBASE_WEB_CONFIG = config
		const { firebaseWebConfig } = await import('./firebase-auth.js')

		expect(firebaseWebConfig()).toBeNull()
		vi.resetModules()
	})
})
