import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { requestSource } from './request-source.js'

const req = (headers: Record<string, string | string[]>, apiKey = false) =>
	({
		headers,
		...(apiKey && { apiKeyAuth: { keyId: 'k', userId: 'u', permissions: [] } }),
	}) as unknown as FastifyRequest

describe('requestSource', () => {
	it('trusts the declared client for a known source', () => {
		expect(requestSource(req({ 'x-innolope-client': 'mcp' }))).toBe('mcp')
	})

	it('falls back to the credential type when no client is declared', () => {
		expect(requestSource(req({}))).toBe('admin')
		expect(requestSource(req({}, true))).toBe('api')
	})

	// The header is attribution, not authorization: anything unrecognized is
	// discarded so the column only ever holds a known source.
	it('discards an unrecognized or forged client value', () => {
		expect(requestSource(req({ 'x-innolope-client': 'wordpress' }))).toBe('admin')
		expect(requestSource(req({ 'x-innolope-client': '' }, true))).toBe('api')
	})

	it('takes the first value when the header is repeated', () => {
		expect(requestSource(req({ 'x-innolope-client': ['mcp', 'admin'] }))).toBe('mcp')
	})
})
