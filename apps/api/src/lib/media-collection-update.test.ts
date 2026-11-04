import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalWriteError, externalFailureBody } from '../services/external-errors.js'
import { contentHash } from './content-hash.js'

const boundary = vi.hoisted(() => ({
	uploadContext: vi.fn(),
	updateExternalDb: vi.fn(),
	fetchLiveExternalRecord: vi.fn(),
}))
vi.mock('../services/media-ingest.js', () => ({
	uploadContext: boundary.uploadContext,
	ingestMedia: vi.fn(),
}))
vi.mock('../services/external-content.js', () => ({
	buildExternalData: (_col: unknown, input: { metadata: object }) => ({ ...input.metadata }),
	updateExternalDb: boundary.updateExternalDb,
	fetchLiveExternalRecord: boundary.fetchLiveExternalRecord,
}))

const projectId = '11111111-1111-4111-8111-111111111111'
const collectionId = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const original = {
	id,
	projectId,
	collectionId,
	externalId: 'image-1',
	slug: null,
	status: 'draft',
	locale: 'en',
	metadata: { alt: 'Before', filename: 'before.png' },
	markdown: '',
	version: 1,
	createdAt: new Date('2026-01-01'),
	updatedAt: new Date('2026-01-01'),
	publishedAt: null,
}

describe('finding 13: collection media updates', () => {
	let app: FastifyInstance
	let agentMediaRoutes: typeof import('../routes/v1/media-agent.js')['agentMediaRoutes']
	beforeAll(async () => {
		;({ agentMediaRoutes } = await import('../routes/v1/media-agent.js'))
	})
	beforeEach(() => vi.resetAllMocks())
	afterEach(async () => app?.close())

	async function fixture(
		failure?: 'history' | 'commit' | 'snapshot',
		changedAfterRollback = false,
		unrelatedSourceEdit = false,
	) {
		let row = structuredClone(original)
		const source = { ...original.metadata }
		let committed = false
		let txNumber = 0
		const timeline: string[] = []
		const select = () => {
			const chain = {
				from: () => chain,
				where: () => chain,
				for: () => chain,
				limit: async () => [{ ...row }],
			}
			return chain
		}
		const db = {
			select,
			transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) => {
				txNumber++
				const first = txNumber === 1
				const before = structuredClone(row)
				const tx = {
					select,
					insert: () => ({
						values: async () => {
							if (first && failure === 'history') throw new Error('history write failed')
						},
					}),
					update: () => ({
						set: (patch: object) => ({
							where: () => ({
								returning: async () => {
									Object.assign(row, patch)
									return [{ ...row }]
								},
							}),
						}),
					}),
				}
				try {
					const value = await write(tx)
					if (first && failure === 'commit') throw new Error('commit failed')
					committed = true
					timeline.push('commit')
					return value
				} catch (err) {
					row = before
					timeline.push('rollback')
					if (changedAfterRollback)
						row = { ...row, metadata: { ...row.metadata, alt: 'Newer' }, version: 2 }
					throw err
				}
			}),
		}
		boundary.uploadContext.mockResolvedValue({
			info: { canUpload: true },
			target: {
				kind: 'collection',
				fields: { alt: 'alt', filename: 'filename' },
				collection: {
					id: collectionId,
					projectId,
					source: 'external',
					accessMode: 'read-write',
					externalTable: 'images',
					fields: [
						{ name: 'alt', type: 'text' },
						{ name: 'filename', type: 'text' },
					],
				},
			},
		})
		boundary.updateExternalDb.mockImplementation(
			async (_app, _pid, _col, _id, patch, _tx, opts) => {
				timeline.push('external-write')
				Object.assign(source, patch)
				if (txNumber === 1 && unrelatedSourceEdit) source.filename = 'newer-source.png'
				for (const key of opts?.unset ?? []) delete (source as Record<string, unknown>)[key]
				opts?.onApplied?.({ status: 'draft', markdown: '', metadata: { ...source } })
				if (failure === 'snapshot' && txNumber === 1) throw new Error('snapshot write failed')
				return { written: patch, doc: { _id: 'image-1', ...source } }
			},
		)
		app = Fastify()
		app.setErrorHandler((err, _request, reply) => {
			if (err instanceof ExternalWriteError)
				return reply.status(err.statusCode).send(externalFailureBody(err.failure))
			return reply.send(err)
		})
		app.decorate('db', db as never)
		app.decorate('requireProject', () => async (request: { project?: unknown; user?: unknown }) => {
			request.project = { id: projectId }
			request.user = { id: 'owner' }
		})
		const emit = vi.fn(() => {
			expect(committed).toBe(true)
			timeline.push('event')
		})
		app.decorate('events', { emit } as never)
		await app.register(agentMediaRoutes, { prefix: '/media' })
		await app.ready()
		return {
			emit,
			timeline,
			source,
			row: () => row,
			update: (payload = { alt: 'After' }) =>
				app.inject({ method: 'PATCH', url: '/media/items/image-1', payload }),
		}
	}

	it.each([
		'history',
		'commit',
		'snapshot',
	] as const)('restores the source after a %s failure and emits nothing', async (failure) => {
		const f = await fixture(failure)
		const response = await f.update()
		expect(response.statusCode).toBe(failure === 'snapshot' ? 502 : 500)
		expect(f.source).toMatchObject(original.metadata)
		expect(f.row().version).toBe(1)
		expect(f.timeline.indexOf('rollback')).toBeLessThan(f.timeline.lastIndexOf('external-write'))
		expect(f.emit).not.toHaveBeenCalled()
	})

	it('emits one content:updated event only after commit with the committed revision', async () => {
		const f = await fixture()
		const response = await f.update()
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			version: 2,
			metadata: { alt: 'After', filename: 'before.png' },
		})
		expect(f.emit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				type: 'content:updated',
				data: expect.objectContaining({ id, projectId, collectionId, version: 2 }),
			}),
		)
		expect(f.timeline).toEqual(['external-write', 'commit', 'event'])
	})

	it('returns a clean source-unreachable 502 and performs no local write when connection fails', async () => {
		const f = await fixture()
		boundary.updateExternalDb.mockRejectedValue(
			Object.assign(new Error('connect refused at secret-db.internal'), { code: 'ECONNREFUSED' }),
		)
		const response = await f.update()
		expect(response.statusCode).toBe(502)
		expect(response.json().error).toMatch(/reach.*database|database.*unreachable/i)
		expect(response.body).not.toContain('secret-db.internal')
		expect(f.row().version).toBe(1)
		expect(f.source).toEqual(original.metadata)
		expect(f.emit).not.toHaveBeenCalled()
	})

	it('rejects a stale hash before touching the source', async () => {
		const f = await fixture()
		const response = await f.update({
			alt: 'After',
			expectedHash: contentHash({ ...original, version: 0 }),
		} as never)
		expect(response.statusCode).toBe(409)
		expect(boundary.updateExternalDb).not.toHaveBeenCalled()
		expect(f.emit).not.toHaveBeenCalled()
	})

	it('preserves an unrelated source edit when compensating an alt update', async () => {
		const f = await fixture('history', false, true)
		const response = await f.update()
		expect(response.statusCode).toBe(500)
		expect(f.source).toEqual({ alt: 'Before', filename: 'newer-source.png' })
		expect(f.emit).not.toHaveBeenCalled()
	})

	it('does not undo a newer committed revision while compensating', async () => {
		const f = await fixture('history', true)
		const response = await f.update()
		expect(response.statusCode).toBe(500)
		expect(boundary.updateExternalDb).toHaveBeenCalledTimes(1)
		expect(f.row().metadata.alt).toBe('Newer')
		expect(f.emit).not.toHaveBeenCalled()
	})
})
