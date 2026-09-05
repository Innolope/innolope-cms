import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudflareR2Adapter } from './cloudflare-r2.js'

describe('CloudflareR2Adapter', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('signs the PUT with SigV4 and returns a URL that points at the written key', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const adapter = new CloudflareR2Adapter({
			bucket: 'media',
			accessKeyId: 'AKID',
			secretAccessKey: 'SECRET',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
			publicUrl: 'https://cdn.example.com',
		})
		const result = await adapter.upload(Buffer.from('hello'), 'photo.jpg', 'image/jpeg')
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
		const headers = init.headers as Record<string, string>
		expect(String(url)).toBe(`https://acct.r2.cloudflarestorage.com/media/${result.id}`)
		expect(result.id).toMatch(/\.jpg$/)
		expect(result.url).toBe(`https://cdn.example.com/${result.id}`)
		expect(headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
		)
		expect(headers['x-amz-content-sha256']).toHaveLength(64)
	})

	it('deletes the same key it wrote', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
		vi.stubGlobal('fetch', fetchMock)
		const adapter = new CloudflareR2Adapter({
			bucket: 'media',
			accessKeyId: 'AKID',
			secretAccessKey: 'SECRET',
			endpoint: 'https://acct.r2.cloudflarestorage.com',
		})
		await adapter.delete('abc.jpg')
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
		expect(String(url)).toBe('https://acct.r2.cloudflarestorage.com/media/abc.jpg')
		expect(init.method).toBe('DELETE')
		expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256/)
	})
})
