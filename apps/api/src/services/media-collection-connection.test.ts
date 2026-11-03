import type { collections } from '@innolope/db'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
	connect: vi.fn(),
	disconnect: vi.fn(),
	update: vi.fn(),
	findById: vi.fn(),
}))
vi.mock('../adapters/external-db.js', () => ({ createExternalDbAdapter: () => boundary }))

import { fetchLiveExternalRecord, updateExternalDb } from './external-content.js'

const col = {
	id: 'collection',
	projectId: 'project',
	externalTable: 'images',
	source: 'external',
	fields: [{ name: 'alt', type: 'text' }],
} as typeof collections.$inferSelect

function fixture() {
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [
						{
							...col,
							settings: {
								externalDb: {
									type: 'postgres',
									connectionString: 'postgres://user:secret@db/source',
								},
							},
						},
					],
				}),
			}),
		}),
	}
	return { db, log: { warn: vi.fn() } } as unknown as FastifyInstance
}

describe('finding 13: source connection failure', () => {
	beforeEach(() => vi.resetAllMocks())

	it.each([
		'update',
		'uncached record',
	] as const)('turns a generic %s adapter connection failure into a clean 502', async (path) => {
		const app = fixture()
		boundary.connect.mockRejectedValue(new Error('driver failed postgres://user:secret@db/source'))
		const result =
			path === 'update'
				? updateExternalDb(app, 'project', col, 'source-id', { alt: 'After' })
				: fetchLiveExternalRecord(app, 'project', col.id, 'source-id')
		await expect(result).rejects.toMatchObject({
			statusCode: 502,
			failure: {
				code: 'EXTERNAL_UNREACHABLE',
				error: expect.stringMatching(/source database.*unreachable|reach.*database/i),
			},
		})
		expect(boundary.disconnect).toHaveBeenCalledOnce()
		expect(boundary.update).not.toHaveBeenCalled()
		expect(boundary.findById).not.toHaveBeenCalled()
		expect(app.log.warn).toHaveBeenCalledOnce()
		expect(JSON.stringify(vi.mocked(app.log.warn).mock.calls)).not.toContain('user:secret')
	})
})
