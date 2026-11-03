import { afterEach, describe, expect, it, vi } from 'vitest'

// safeFetch requests through undici's own fetch (with the connect-time address
// guard), so that is the boundary to fake — the global fetch is never used.
const undici = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('undici', async (importOriginal) => ({
	...(await importOriginal<typeof import('undici')>()),
	fetch: undici.fetch,
}))

import { fetchSourceImage } from './media-ingest-policy.js'

// Real safeFetch screening, with numeric public hosts to keep DNS/network out of the oracle.
afterEach(() => undici.fetch.mockReset())
describe('media source redirect SSRF guard', () => {
	it.each([
		'http://127.0.0.1/image',
		'http://169.254.169.254/latest/meta-data/',
		'http://[::1]/image',
		'file:///tmp/image',
	])('refuses %s before fetching', async (url) => {
		await expect(fetchSourceImage(url, 100)).rejects.toThrow(/private|http/)
		expect(undici.fetch).not.toHaveBeenCalled()
	})
	it('screens a redirect to private metadata before issuing the second request', async () => {
		undici.fetch.mockImplementation(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: 'http://169.254.169.254/latest/meta-data/' },
				}),
		)
		await expect(fetchSourceImage('https://8.8.8.8/source', 100)).rejects.toThrow(/private/)
		expect(undici.fetch).toHaveBeenCalledTimes(1)
		expect(undici.fetch.mock.calls[0]).toHaveLength(2)
	})
	it('stops redirect loops after five screened hops', async () => {
		undici.fetch.mockImplementation(
			async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
		)
		await expect(fetchSourceImage('https://8.8.8.8/loop', 100)).rejects.toThrow(/redirect limit/)
		expect(undici.fetch).toHaveBeenCalledTimes(6)
	})
})
