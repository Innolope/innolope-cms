import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The preflight (`validatePublicUrl`) sees a public address; the lookup made when
// the socket opens is what a TTL-0 rebinding host would answer — loopback.
const dns = vi.hoisted(() => ({
	connectAnswer: [{ address: '127.0.0.1', family: 4 }] as Array<{
		address: string
		family: number
	}>,
}))
vi.mock('node:dns/promises', () => ({
	lookup: async () => [{ address: '93.184.216.34', family: 4 }],
	resolveSrv: vi.fn(),
}))
vi.mock('node:dns', () => ({
	lookup: (
		_host: string,
		_opts: object,
		callback: (err: Error | null, addresses: typeof dns.connectAnswer) => void,
	) => callback(null, dns.connectAnswer),
}))

import { publicLookup, safeFetch } from './connection-guard.js'

describe('connect-time address screening (DNS rebinding)', () => {
	let server: Server
	let port = 0
	let hits = 0

	beforeAll(async () => {
		server = createServer((_req, res) => {
			hits++
			res.end('internal')
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		port = (server.address() as AddressInfo).port
	})
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
	beforeEach(() => {
		hits = 0
	})

	it('refuses a host that passes the preflight but resolves to loopback at connect time', async () => {
		dns.connectAnswer = [{ address: '127.0.0.1', family: 4 }]
		// Real undici: the request must fail before it ever reaches the local server.
		await expect(safeFetch(`http://rebinding.example:${port}/image`)).rejects.toThrow()
		expect(hits).toBe(0)
	})

	it.each([
		'169.254.169.254',
		'10.0.0.2',
		'::ffff:7f00:1',
	])('rejects a connect-time answer containing %s', async (address) => {
		dns.connectAnswer = [
			{ address: '93.184.216.34', family: 4 },
			{ address, family: address.includes(':') ? 6 : 4 },
		]
		const err = await new Promise<Error | null>((resolve) =>
			publicLookup('rebinding.example', { all: true }, (e) => resolve(e)),
		)
		expect(err?.message).toMatch(/private/)
	})

	it('passes public answers through to the connector', async () => {
		dns.connectAnswer = [{ address: '93.184.216.34', family: 4 }]
		const result = await new Promise<{ err: Error | null; address: unknown }>((resolve) =>
			publicLookup('example.com', {}, (err, address) => resolve({ err, address })),
		)
		expect(result).toEqual({ err: null, address: '93.184.216.34' })
	})
})
