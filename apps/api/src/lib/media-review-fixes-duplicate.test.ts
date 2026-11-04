import { beforeAll, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ ingestOnce: vi.fn(), mediaDelivery: vi.fn() }))
vi.mock('../services/media-ledger.js', () => ({ ingestOnce: boundary.ingestOnce }))
vi.mock('../services/media-delivery.js', () => ({ mediaDelivery: boundary.mediaDelivery }))

describe('duplicate media receipts', () => {
	let ingestMedia: typeof import('../services/media-ingest.js').ingestMedia
	beforeAll(async () => {
		;({ ingestMedia } = await import('../services/media-ingest.js'))
	})
	it('returns fresh verification without warnings from the original failed probe', async () => {
		const fullPath = 'https://imagedelivery.net/hash/id'
		boundary.ingestOnce.mockResolvedValue({
			id: 'one',
			fullPath,
			duplicate: true,
			warnings: ['delivery probe failed'],
		})
		boundary.mediaDelivery.mockResolvedValue({
			deliveryUrl: `${fullPath}/public`,
			deliveryVerified: true,
		})
		const target = { kind: 'library' as const, variant: 'public', fallbackVariant: 'public' }
		const result = await ingestMedia(
			{ db: {} } as never,
			{ project: { id: 'project' } } as never,
			{
				buffer: Buffer.from(
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=',
					'base64',
				),
			},
			{ target, info: { canUpload: true, maxBytes: 10_000_000 } } as never,
		)
		expect(result).toMatchObject({
			duplicate: true,
			deliveryVerified: true,
			deliveryUrl: `${fullPath}/public`,
		})
		expect(result.warnings).toBeUndefined()
	})
})
