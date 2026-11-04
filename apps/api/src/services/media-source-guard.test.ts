import { afterEach, describe, expect, it, vi } from 'vitest'

// safeFetch sends each hop through guardedRequest (the connect-time address
// guard), so that is the boundary to fake — the global fetch is never used.
const transport = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../adapters/guarded-request.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../adapters/guarded-request.js')>()),
	guardedRequest: transport.fetch,
}))

import { fetchSourceImage } from './media-ingest-policy.js'

// Real safeFetch screening, with numeric public hosts to keep DNS/network out of the oracle.
afterEach(() => transport.fetch.mockReset())
describe('media source redirect SSRF guard', () => {
	it.each([
		'http://127.0.0.1/image',
		'http://169.254.169.254/latest/meta-data/',
		'http://[::1]/image',
		'file:///tmp/image',
	])('refuses %s before fetching', async (url) => {
		await expect(fetchSourceImage(url, 100)).rejects.toThrow(/private|http/)
		expect(transport.fetch).not.toHaveBeenCalled()
	})
	it('screens a redirect to private metadata before issuing the second request', async () => {
		transport.fetch.mockImplementation(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: 'http://169.254.169.254/latest/meta-data/' },
				}),
		)
		await expect(fetchSourceImage('https://8.8.8.8/source', 100)).rejects.toThrow(/private/)
		expect(transport.fetch).toHaveBeenCalledTimes(1)
		expect(transport.fetch.mock.calls[0]).toHaveLength(3)
	})
	it('stops redirect loops after five screened hops', async () => {
		transport.fetch.mockImplementation(
			async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
		)
		await expect(fetchSourceImage('https://8.8.8.8/loop', 100)).rejects.toThrow(/redirect limit/)
		expect(transport.fetch).toHaveBeenCalledTimes(6)
	})
})
