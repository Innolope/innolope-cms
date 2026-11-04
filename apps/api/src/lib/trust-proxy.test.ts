import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicBaseUrl } from '../services/oauth-metadata.js'
import { parseTrustProxy } from './trust-proxy.js'

afterEach(() => vi.unstubAllEnvs())
describe('R2 proxy trust is explicit and bounded', () => {
	it.each([
		['1', 1],
		['2', 2],
		[' true ', 1],
		['YES', 1],
		['on', 1],
		[undefined, false],
		['', false],
		['0', false],
		['false', false],
		['-1', false],
		['1.5', false],
		['NaN', false],
		['9007199254740992', false],
	])('parses %s', (value, expected) =>
		expect(parseTrustProxy(value as string | undefined)).toBe(expected))
	it('uses the last trusted hop and preserves current behavior when unset', async () => {
		for (const trustProxy of [parseTrustProxy('true'), parseTrustProxy(undefined)]) {
			const app = Fastify({ trustProxy })
			app.get('/', (request) => ({ ip: request.ip }))
			try {
				const response = await app.inject({
					url: '/',
					remoteAddress: '127.0.0.1',
					headers: { 'x-forwarded-for': '198.51.100.100, 8.8.8.8' },
				})
				expect(response.json().ip).toBe(trustProxy ? '8.8.8.8' : '127.0.0.1')
			} finally {
				await app.close()
			}
		}
	})
	it('honors forwarded origin for positive integer TRUST_PROXY consistently', () => {
		vi.stubEnv('PUBLIC_URL', '')
		vi.stubEnv('ADMIN_URL', '')
		vi.stubEnv('TRUST_PROXY', '2')
		expect(
			publicBaseUrl({
				headers: {
					host: 'local',
					'x-forwarded-proto': 'https',
					'x-forwarded-host': 'public.example',
				},
				protocol: 'http',
				log: { warn: vi.fn() },
			} as never),
		).toBe('https://public.example')
	})
})
