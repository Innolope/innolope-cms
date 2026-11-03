import { createHash } from 'node:crypto'
import { InnolopeClient } from '@innolope/mcp-server/lib'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaItemHash } from './media-item-hash.js'

const boundary = vi.hoisted(() => ({
	ingestMedia: vi.fn(),
	uploadContext: vi.fn(),
	ingestOnce: vi.fn(),
	mediaDelivery: vi.fn(),
}))
vi.mock('../services/media-ingest.js', async (original) => ({
	...(await original<typeof import('../services/media-ingest.js')>()),
	ingestMedia: boundary.ingestMedia,
	uploadContext: boundary.uploadContext,
}))
vi.mock('../services/media-ledger.js', () => ({ ingestOnce: boundary.ingestOnce }))
vi.mock('../services/media-delivery.js', () => ({ mediaDelivery: boundary.mediaDelivery }))

const projectId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const uploadId = '33333333-3333-4333-8333-333333333333'
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=',
	'base64',
)

describe('independent media review regressions', () => {
	let app: FastifyInstance | undefined
	let actualIngest: typeof import('../services/media-ingest.js')
	beforeAll(async () => {
		actualIngest = await vi.importActual('../services/media-ingest.js')
	})
	beforeEach(() => vi.resetAllMocks())
	afterEach(async () => app?.close())

	it('keeps an already signed private Cloudflare URL intact in list_media', async () => {
		const client = Object.create(InnolopeClient.prototype) as InnolopeClient
		const signed = 'https://imagedelivery.net/hash/id/public?exp=2000000000&sig=valid-signature'
		vi.spyOn(client, 'mediaUploadTarget').mockResolvedValue({
			resolved: {
				kind: 'collection',
				collectionId: uploadId,
				deliveryVariant: 'width=1440',
				fields: { path: 'fullPath', filename: 'filename', alt: 'alt' },
			},
		} as never)
		vi.spyOn(client, 'listContent').mockResolvedValue({
			data: [
				{ id: uploadId, externalId: '123', metadata: { fullPath: signed, filename: 'one.png' } },
			],
			pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
		} as never)
		const result = await client.listUploadMedia()
		expect(result.data[0]).toMatchObject({ fullPath: signed, deliveryUrl: signed, url: signed })
	})

	it('invalidates the library hash when either editable field changes', () => {
		const item = {
			id: uploadId,
			projectId,
			filename: 'first.png',
			alt: 'First',
			url: 'https://cdn.test/one.png',
		}
		const hash = mediaItemHash(item)
		expect(mediaItemHash({ ...item, alt: 'Second' })).not.toBe(hash)
		expect(mediaItemHash({ ...item, filename: 'second.png' })).not.toBe(hash)
		expect(mediaItemHash({ ...item, id: userId })).not.toBe(hash)
	})

	it('refreshes a human-upload receipt before returning its duplicate delivery URL', async () => {
		const fullPath = 'https://imagedelivery.net/hash/id'
		boundary.ingestOnce.mockResolvedValue({
			id: uploadId,
			fullPath,
			deliveryUrl: fullPath,
			duplicate: true,
		})
		boundary.mediaDelivery.mockResolvedValue({
			deliveryUrl: `${fullPath}/public`,
			deliveryVerified: true,
		})
		const target = { kind: 'library' as const, variant: 'public', fallbackVariant: 'public' }
		const result = await actualIngest.ingestMedia(
			{ db: {} } as never,
			{ project: { id: projectId } } as never,
			{ buffer: png },
			{ target, info: { canUpload: true, maxBytes: 10_000_000 } } as never,
		)
		expect(boundary.mediaDelivery).toHaveBeenCalledWith(fullPath, target)
		expect(result).toMatchObject({
			duplicate: true,
			deliveryUrl: `${fullPath}/public`,
			deliveryVerified: true,
		})
	})

	async function completionFixture(overrides: Record<string, unknown> = {}) {
		const token = 'review-capability-token'
		const session = {
			id: uploadId,
			projectId,
			userId,
			filename: 'one.png',
			mimeType: 'image/png',
			data: png as Buffer | null,
			status: 'uploaded',
			result: null as unknown,
			expiresAt: new Date(Date.now() + 60_000),
			updatedAt: new Date(),
			bytes: png.length,
			tokenHash: createHash('sha256').update(token).digest('hex'),
			...overrides,
		}
		const transaction = vi.fn(() => {
			throw new Error('completion must not reserve a pool transaction during ingest')
		})
		const db = {
			transaction,
			select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...session }] }) }) }),
			update: vi.fn(() => ({
				set: (patch: Record<string, unknown>) => ({
					where: () => {
						const apply = () => {
							if (patch.status === 'processing' && session.status !== 'uploaded') return []
							if (patch.data && !['created', 'uploaded'].includes(session.status)) return []
							if (
								patch.status === 'uploaded' &&
								!patch.updatedAt &&
								session.updatedAt.getTime() >= Date.now() - 300_000
							)
								return []
							Object.assign(session, patch)
							return [{ ...session }]
						}
						const pending = Promise.resolve().then(apply)
						return Object.assign(pending, { returning: () => pending })
					},
				}),
			})),
		}
		app = Fastify()
		app.decorate('license', { hasFeature: () => true } as never)
		app.decorate('db', db as unknown as FastifyInstance['db'])
		app.decorate('requireLicense', () => async () => {})
		app.decorate(
			'requireProject',
			() => async (request: { project?: unknown; user?: unknown; projectRole?: string }) => {
				request.project = { id: projectId }
				request.user = { id: userId }
				request.projectRole = 'owner'
			},
		)
		const { agentMediaRoutes } = await import('../routes/v1/media-agent.js')
		await app.register(agentMediaRoutes, { prefix: '/media' })
		await app.ready()
		const currentApp = app
		return {
			session,
			transaction,
			update: db.update,
			put: (payload: Buffer, suppliedToken = token, headers: Record<string, string> = {}) =>
				currentApp.inject({
					method: 'PUT',
					url: `/media/uploads/${uploadId}/content?token=${suppliedToken}`,
					payload,
					headers,
				}),
			complete: () =>
				currentApp.inject({
					method: 'POST',
					url: `/media/uploads/${uploadId}/complete`,
					payload: {},
				}),
		}
	}

	it('rechecks the library license before replaying a completed receipt', async () => {
		boundary.ingestMedia.mockResolvedValue({
			id: uploadId,
			target: { kind: 'library' },
			deliveryUrl: 'https://cdn.test/one.png',
			duplicate: false,
		})
		const fixture = await completionFixture()
		expect((await fixture.complete()).statusCode).toBe(200)
		if (!app) throw new Error('Expected the completion fixture app')
		vi.spyOn(app.license, 'hasFeature').mockReturnValue(false)
		const replay = await fixture.complete()
		expect(replay.statusCode).toBe(403)
		expect(replay.body).toContain('media-integrations')
		expect(boundary.ingestMedia).toHaveBeenCalledTimes(1)
	})

	it('ten concurrent completions ingest once without reserving a transaction connection', async () => {
		const result = { id: uploadId, deliveryUrl: 'https://cdn.test/one.png', duplicate: false }
		boundary.ingestMedia.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 15))
			return result
		})
		const fixture = await completionFixture()
		const responses = await Promise.all(Array.from({ length: 10 }, () => fixture.complete()))
		for (const response of responses) {
			expect(response.statusCode, response.body).toBe(200)
			expect(response.json()).toEqual(result)
		}
		expect(boundary.ingestMedia).toHaveBeenCalledTimes(1)
		expect(fixture.transaction).not.toHaveBeenCalled()
		expect(fixture.session).toMatchObject({ status: 'done', data: null, result })
	})

	it('releases the completion claim after ingest fails so retry can recover', async () => {
		boundary.ingestMedia
			.mockRejectedValueOnce(new Error('Provider unavailable'))
			.mockResolvedValueOnce({ id: uploadId })
		const fixture = await completionFixture()
		const failed = await fixture.complete()
		expect(failed.statusCode).toBe(500)
		expect(fixture.session.status).toBe('uploaded')
		expect(fixture.session.data).toEqual(png)
		const recovered = await fixture.complete()
		expect(recovered.statusCode, recovered.body).toBe(200)
		expect(fixture.session).toMatchObject({ status: 'done', data: null })
		expect(boundary.ingestMedia).toHaveBeenCalledTimes(2)
		expect(fixture.transaction).not.toHaveBeenCalled()
	})

	it.each([
		['malformed JSON', Buffer.from('{broken'), { 'content-type': 'application/json' }],
		[
			'oversized bytes',
			Buffer.alloc(2 * 1024 * 1024),
			{ 'content-type': 'application/octet-stream' },
		],
	])('rejects a wrong capability before parsing %s', async (_name, body, headers) => {
		const fixture = await completionFixture()
		const response = await fixture.put(body, 'wrong-token', headers)
		expect(response.statusCode, response.body).toBe(404)
		expect(fixture.update).not.toHaveBeenCalled()
		expect(boundary.ingestMedia).not.toHaveBeenCalled()
		expect(fixture.session.data).toEqual(png)
	})

	it('rejects an expired capability before parsing malformed bytes', async () => {
		const fixture = await completionFixture({ expiresAt: new Date(Date.now() - 1) })
		const response = await fixture.put(Buffer.from('{broken'), undefined, {
			'content-type': 'application/json',
		})
		expect(response.statusCode, response.body).toBe(410)
		expect(fixture.update).not.toHaveBeenCalled()
	})

	it('enforces the declaration against actual bytes without a Content-Type header', async () => {
		const fixture = await completionFixture({ bytes: 3 })
		const response = await fixture.put(Buffer.from('1234'))
		expect(response.statusCode, response.body).toBe(413)
		expect(response.body).toMatch(/declared size/i)
		expect(fixture.update).not.toHaveBeenCalled()
	})

	it('overwrites bytes on repeated PUT before completion', async () => {
		const fixture = await completionFixture()
		for (const body of [Buffer.from('first'), Buffer.from('second')]) {
			const response = await fixture.put(body)
			expect(response.statusCode, response.body).toBe(200)
			expect(response.json()).toEqual({
				uploadId,
				bytes: body.length,
				sha256: createHash('sha256').update(body).digest('hex'),
			})
			expect(fixture.session.data).toEqual(body)
		}
	})

	it('rejects completion before PUT without claiming the session', async () => {
		const fixture = await completionFixture({ data: null, status: 'created' })
		const response = await fixture.complete()
		expect(response.statusCode, response.body).toBe(400)
		expect(response.body).toMatch(/PUT the bytes/i)
		expect(fixture.update).not.toHaveBeenCalled()
		expect(boundary.ingestMedia).not.toHaveBeenCalled()
	})

	it('denies a collection metadata edit when its resolved target is outside the write allowlist', async () => {
		const fixture = await completionFixture()
		boundary.uploadContext.mockResolvedValue({
			target: { kind: 'collection', collection: { id: uploadId } },
			info: { canUpload: false, problem: 'You do not have access to this collection' },
		})
		if (!app) throw new Error('Expected fixture app')
		const response = await app.inject({
			method: 'PATCH',
			url: '/media/items/external-row-id',
			payload: { alt: 'Forbidden' },
		})
		expect(response.statusCode, response.body).toBe(403)
		expect(response.body).toMatch(/access to this collection/)
		expect(fixture.update).not.toHaveBeenCalled()
		expect(fixture.transaction).not.toHaveBeenCalled()
	})

	it('serializes concurrent library edits and rejects the second stale expectedHash', async () => {
		await completionFixture()
		if (!app) throw new Error('Expected fixture app')
		const item = {
			id: uploadId,
			projectId,
			filename: 'first.png',
			alt: 'Initial',
			url: 'https://cdn.test/one.png',
		}
		const expectedHash = mediaItemHash(item)
		const forUpdate = vi.fn()
		const select = () => {
			const query = {
				from: () => query,
				where: () => query,
				for: (mode: string) => {
					forUpdate(mode)
					return query
				},
				limit: async () => [{ ...item }],
			}
			return query
		}
		let queue = Promise.resolve()
		const db = {
			select,
			update: () => ({
				set: (patch: Record<string, unknown>) => ({
					where: () => ({
						returning: async () => {
							Object.assign(item, patch)
							return [{ ...item }]
						},
					}),
				}),
			}),
			transaction: async (perform: (tx: unknown) => Promise<unknown>) => {
				const previous = queue
				let release = () => {}
				queue = new Promise<void>((resolve) => {
					release = resolve
				})
				await previous
				try {
					return await perform(db)
				} finally {
					release()
				}
			},
		}
		app.db = db as never
		const currentApp = app
		const responses = await Promise.all(
			['First edit', 'Second edit'].map((alt) =>
				currentApp.inject({
					method: 'PATCH',
					url: `/media/items/${uploadId}`,
					payload: { alt, expectedHash },
				}),
			),
		)
		expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
		expect(forUpdate).toHaveBeenCalledTimes(2)
		expect(forUpdate).toHaveBeenCalledWith('update')
		const success = responses.find((response) => response.statusCode === 200)
		if (!success) throw new Error('Expected one successful edit')
		expect(item.alt).toBe(success.json().alt)
		expect(success.json().contentHash).toBe(mediaItemHash(item))
	})
})
