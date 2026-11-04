import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { describeExternalDbError, ExternalWriteError } from '../services/external-errors.js'
import { registerRequestErrors } from './request-errors.js'
import { redactRequestUrl, redactTelemetryRequest } from './request-url.js'

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@sentry/node', () => sentry)
afterEach(() => {
	vi.unstubAllEnvs()
	vi.clearAllMocks()
})
describe('R5 capability URL privacy', () => {
	it.each([
		{ query: 'token=private-capability&size=3', expected: 'token=[REDACTED]&size=3' },
		{
			query: { token: 'private-capability', size: '3' },
			expected: { token: '[REDACTED]', size: '3' },
		},
		{
			query: [
				['token', 'private-capability'],
				['size', '3'],
			],
			expected: [
				['token', '[REDACTED]'],
				['size', '3'],
			],
		},
	])('redacts automatically captured Sentry request data', ({ query, expected }) => {
		const request = { url: '/uploads/one?token=private-capability', query_string: query }
		redactTelemetryRequest(request)
		expect(request).toEqual({ url: '/uploads/one?token=[REDACTED]', query_string: expected })
	})

	it.each([
		'/api/uploads/id?token=secret&size=3',
		'/api/uploads/id?x=1&token=secret&token=secret',
		'/api/uploads/id?%74oken=secret',
	])('redacts token values from %s', (url) => {
		expect(redactRequestUrl(url)).not.toContain('secret')
		expect(redactRequestUrl(url)).toContain('[REDACTED]')
	})
	it.each([
		['server', () => new Error('database unavailable'), 500],
		['oversize', () => Object.assign(new Error('too large'), { statusCode: 413 }), 413],
		[
			'validation',
			() => {
				const result = z.string().safeParse(123)
				if (result.success) throw new Error('fixture')
				return result.error
			},
			400,
		],
		[
			'external',
			() =>
				new ExternalWriteError(
					describeExternalDbError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
				),
			502,
		],
	] as const)('redacts the %s error log and Sentry context', async (_name, makeError, status) => {
		const app = Fastify({ disableRequestLogging: true })
		vi.stubEnv('SENTRY_DSN', 'test')
		const logs = [vi.spyOn(app.log, 'error'), vi.spyOn(app.log, 'warn'), vi.spyOn(app.log, 'info')]
		registerRequestErrors(app)
		app.put('/uploads/:id', async () => {
			throw makeError()
		})
		try {
			const response = await app.inject({
				method: 'PUT',
				url: '/uploads/one?token=private-capability',
				payload: '',
			})
			expect(response.statusCode).toBe(status)
			const entries = logs.flatMap((log) => log.mock.calls.map((call) => call[0]))
			expect(entries).toEqual(
				expect.arrayContaining([expect.objectContaining({ url: '/uploads/one?token=[REDACTED]' })]),
			)
			expect(JSON.stringify(entries)).not.toContain('private-capability')
			expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain('private-capability')
			if (status === 500)
				expect(sentry.captureException).toHaveBeenCalledWith(
					expect.any(Error),
					expect.objectContaining({
						extra: expect.objectContaining({ url: '/uploads/one?token=[REDACTED]' }),
					}),
				)
		} finally {
			await app.close()
		}
	})
})
