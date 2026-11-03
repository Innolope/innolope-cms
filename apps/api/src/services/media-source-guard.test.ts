import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSourceImage } from './media-ingest-policy.js'

// Real safeFetch screening, with numeric public hosts to keep DNS/network out of the oracle.
afterEach(() => vi.unstubAllGlobals())
describe('media source redirect SSRF guard', () => {
	it.each([
		'http://127.0.0.1/image',
		'http://169.254.169.254/latest/meta-data/',
		'http://[::1]/image',
		'file:///tmp/image',
	])('refuses %s before fetching', async (url) => {
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		await expect(fetchSourceImage(url, 100)).rejects.toThrow(/private|http/)
		expect(fetch).not.toHaveBeenCalled()
	})
	it('screens a redirect to private metadata before issuing the second request', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: 'http://169.254.169.254/latest/meta-data/' },
				}),
		)
		vi.stubGlobal('fetch', fetch)
		await expect(fetchSourceImage('https://8.8.8.8/source', 100)).rejects.toThrow(/private/)
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch.mock.calls[0]).toHaveLength(2)
	})
	it('stops redirect loops after five screened hops', async () => {
		const fetch = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
		)
		vi.stubGlobal('fetch', fetch)
		await expect(fetchSourceImage('https://8.8.8.8/loop', 100)).rejects.toThrow(/redirect limit/)
		expect(fetch).toHaveBeenCalledTimes(6)
	})
})
