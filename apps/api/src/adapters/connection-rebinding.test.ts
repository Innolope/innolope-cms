import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
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
import { guardedRequest, screenedLookup } from './guarded-request.js'

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

// The transport under safeFetch must hand callers what fetch did: decoded bodies,
// every header, the request body, and the URL it answered for. IP-literal hosts
// skip the lookup, so these run against a local server with screening relaxed.
describe('guardedRequest response conversion', () => {
	let server: Server
	let base = ''
	const seen: Array<{ method?: string; body: string; headers: Record<string, unknown> }> = []
	const allowAll = screenedLookup(() => false)

	beforeAll(async () => {
		server = createServer((req, res) => {
			let body = ''
			req.on('data', (chunk) => {
				body += chunk
			})
			req.on('end', () => {
				seen.push({ method: req.method, body, headers: req.headers })
				if (req.url === '/gzip') {
					res.writeHead(200, { 'content-encoding': 'gzip', 'x-multi': ['a', 'b'] })
					res.end(gzipSync('decoded text'))
				} else if (req.url === '/empty') {
					res.writeHead(204)
					res.end()
				} else {
					res.writeHead(201, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ echoed: body }))
				}
			})
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

	it('decodes gzip, keeps repeated headers and reports the URL', async () => {
		const res = await guardedRequest(`${base}/gzip`, {}, allowAll)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('decoded text')
		expect(res.headers.get('x-multi')).toBe('a, b')
		expect(res.url).toBe(`${base}/gzip`)
		expect(seen.at(-1)?.headers['accept-encoding']).toBe('gzip, deflate, br')
	})

	it('sends a POST body with its headers', async () => {
		const res = await guardedRequest(
			`${base}/echo`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
			allowAll,
		)
		expect(res.status).toBe(201)
		expect(await res.json()).toEqual({ echoed: '{"a":1}' })
		expect(seen.at(-1)).toMatchObject({
			method: 'POST',
			body: '{"a":1}',
			headers: { 'content-type': 'application/json', 'content-length': '7' },
		})
	})

	it('returns a null body for 204', async () => {
		const res = await guardedRequest(`${base}/empty`, {}, allowAll)
		expect(res.status).toBe(204)
		expect(res.body).toBeNull()
	})
})
