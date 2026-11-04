import type { FastifyInstance, FastifyRequest } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storeMediaBuffer } from './media-ingest.js'

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	upload: vi.fn(),
	insert: vi.fn(),
	disconnect: vi.fn(),
}))
vi.mock('../plugins/media.js', async (original) => ({
	...(await original<typeof import('../plugins/media.js')>()),
	resolveMediaAdapter: mocks.resolve,
}))
vi.mock('../lib/media-upload.js', async (original) => ({
	...(await original<typeof import('../lib/media-upload.js')>()),
	uploadToImportedStorage: mocks.upload,
}))
vi.mock('../adapters/external-db.js', () => ({
	createExternalDbAdapter: () => ({
		connect: async () => {},
		insert: mocks.insert,
		disconnect: mocks.disconnect,
	}),
}))
const input = { buffer: Buffer.from('pdf'), filename: 'one.pdf', mimeType: 'application/pdf' }
const target = {
	kind: 'collection',
	collection: {
		id: 'collection',
		externalTable: 'files',
		fields: ['path', 'filename'].map((name) => ({ name, type: 'text' })),
	},
	entry: { adapter: 'r2', pathColumn: 'path' },
	fields: { path: 'path', filename: 'filename' },
} as never
function fixture() {
	const values = vi.fn()
	const cache = vi.fn(async () => [{ id: 'cached', filename: input.filename }])
	const warn = vi.fn()
	const emit = vi.fn()
	const app = {
		db: {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [
							{ settings: { externalDb: { type: 'postgres', connectionString: 'hidden' } } },
						],
					}),
				}),
			}),
			insert: () => ({
				values: (row: unknown) => {
					values(row)
					return { returning: cache }
				},
			}),
		},
		events: { emit },
	} as unknown as FastifyInstance
	const request = {
		project: { id: 'project' },
		user: { id: 'user' },
		log: { warn },
		headers: {},
	} as unknown as FastifyRequest
	return { app, request, warn, emit, values, cache }
}
beforeEach(() => {
	vi.resetAllMocks()
	mocks.upload.mockResolvedValue({ key: 'files/one.pdf' })
	mocks.insert.mockResolvedValue({ _id: 'external' })
})
describe('review storage boundaries', () => {
	it('R9 keeps imported admin file uploads free of agent events and attribution stamps', async () => {
		const f = fixture()
		await storeMediaBuffer(f.app, f.request, input, target)
		expect(f.emit).not.toHaveBeenCalled()
		expect(f.values.mock.calls[0][0]).not.toHaveProperty('updatedSource')
	})
	it('R8 logs external insert causes and includes a safe reason with the partial-failure receipt', async () => {
		const f = fixture()
		const err = Object.assign(new Error('private raw driver detail'), {
			code: '23502',
			column_name: 'filename',
		})
		mocks.insert.mockRejectedValue(err)
		await expect(storeMediaBuffer(f.app, f.request, input, target, true)).rejects.toMatchObject({
			statusCode: 502,
			message: expect.stringMatching(/required by the source database/),
		})
		expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ err }), expect.any(String))
		expect(f.cache).not.toHaveBeenCalled()
	})
	it('R8 logs cache failures and includes the safe reason without driver parameters', async () => {
		const f = fixture()
		const err = Object.assign(new Error('Failed query params secret'), {
			cause: Object.assign(new Error('bad'), { code: 'ECONNREFUSED' }),
		})
		f.cache.mockRejectedValue(err)
		await expect(storeMediaBuffer(f.app, f.request, input, target, true)).rejects.toMatchObject({
			statusCode: 502,
			message: expect.stringMatching(/Could not reach the external database/),
		})
		expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ err }), expect.any(String))
	})
	it('R14 never exposes an internal adapter-resolution query error', async () => {
		const f = fixture()
		const err = new Error('Failed query select params secret')
		mocks.resolve.mockRejectedValue(err)
		try {
			await storeMediaBuffer(f.app, f.request, input, { kind: 'library' } as never, true)
			expect.fail('must reject')
		} catch (caught) {
			expect(caught).toBe(err)
			expect(caught).not.toHaveProperty('expose', true)
		}
	})
	it('R14 exposes the storage upload reason for agents', async () => {
		const f = fixture()
		mocks.resolve.mockResolvedValue({
			adapter: {
				upload: async () => {
					throw new Error('provider quota exceeded')
				},
			},
		})
		await expect(
			storeMediaBuffer(f.app, f.request, input, { kind: 'library' } as never, true),
		).rejects.toMatchObject({ statusCode: 502, expose: true, message: 'provider quota exceeded' })
	})
})
