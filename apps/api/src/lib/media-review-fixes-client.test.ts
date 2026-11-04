import { InnolopeClient } from '@innolope/mcp-server/lib'
import { InnolopeApiError } from '@innolope/sdk'
import { describe, expect, it, vi } from 'vitest'

describe('media review client regressions', () => {
	it('returns the library target and a license note when media listing is forbidden', async () => {
		const client = Object.create(InnolopeClient.prototype) as InnolopeClient
		const target = { resolved: { kind: 'library', collectionId: null } }
		vi.spyOn(client, 'mediaUploadTarget').mockResolvedValue(target as never)
		vi.spyOn(client, 'listMedia').mockRejectedValue(
			new InnolopeApiError(403, { error: 'media-integrations license required' }),
		)
		const result = await client.listUploadMedia()
		expect(result).toMatchObject({ target, data: [] })
		expect(JSON.stringify(result)).toMatch(/license/i)
	})
	it('propagates non-license listing failures', async () => {
		const client = Object.create(InnolopeClient.prototype) as InnolopeClient
		vi.spyOn(client, 'mediaUploadTarget').mockResolvedValue({
			resolved: { kind: 'library' },
		} as never)
		vi.spyOn(client, 'listMedia').mockRejectedValue(
			new InnolopeApiError(500, { error: 'server failed' }),
		)
		await expect(client.listUploadMedia()).rejects.toThrow()
	})
})
