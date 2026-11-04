import { mediaUploadSessions, projects } from '@innolope/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ uploadContext: vi.fn() }))
vi.mock('../services/media-ingest.js', () => ({
	uploadContext: boundary.uploadContext,
	ingestMedia: vi.fn(),
}))

import { agentMediaRoutes } from '../routes/v1/media-agent.js'

let app: FastifyInstance
const pid = '11111111-1111-4111-8111-111111111111'
const uid = '22222222-2222-4222-8222-222222222222'
afterEach(async () => {
	await app?.close()
	vi.resetAllMocks()
})
async function fixture(userSessions = 0, declaredBytes = 0) {
	const lock = vi.fn()
	const inserts = vi.fn()
	let queue = Promise.resolve()
	const db = {
		select: () => ({
			from: (table: unknown) => ({
				where: () => {
					if (table === projects)
						return {
							for: async (mode: string) => {
								lock(mode)
								return [{ id: pid }]
							},
						}
					if (table !== mediaUploadSessions) throw new Error('unexpected table')
					return Promise.resolve([{ userSessions, declaredBytes }])
				},
			}),
		}),
		insert: () => ({
			values: (data: { bytes: number }) => ({
				returning: async () => {
					inserts(data)
					userSessions++
					declaredBytes += data.bytes
					return [{ id: uid }]
				},
			}),
		}),
		transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
			const previous = queue
			let release = () => {}
			queue = new Promise<void>((resolve) => {
				release = resolve
			})
			await previous
			try {
				return await run(db)
			} finally {
				release()
			}
		}),
	}
	app = Fastify()
	app.decorate('db', db as never)
	app.decorate('requireProject', () => async (request: { project?: unknown; user?: unknown }) => {
		request.project = { id: pid }
		request.user = { id: uid }
	})
	boundary.uploadContext.mockResolvedValue({
		target: { kind: 'library' },
		info: { canUpload: true, maxBytes: 10_000_000 },
	})
	await app.register(agentMediaRoutes, { prefix: '/media' })
	await app.ready()
	return {
		db,
		lock,
		inserts,
		create: (bytes = 1) =>
			app.inject({
				method: 'POST',
				url: '/media/uploads',
				payload: { filename: 'one.png', mimeType: 'image/png', bytes },
			}),
	}
}
describe('R3 upload session admission budgets', () => {
	it('admits the twentieth session but rejects the twenty-first before insertion', async () => {
		const f = await fixture(19)
		expect((await f.create()).statusCode).toBe(201)
		const rejected = await f.create()
		expect(rejected.statusCode).toBe(429)
		expect(rejected.body).toMatch(/complete.*expire/i)
		expect(f.inserts).toHaveBeenCalledTimes(1)
		expect(f.lock).toHaveBeenCalledWith('update')
	})
	it('admits exactly 200 MB but rejects the next declared byte', async () => {
		const f = await fixture(0, 190_000_000)
		expect((await f.create(10_000_000)).statusCode).toBe(201)
		expect((await f.create()).statusCode).toBe(429)
		expect(f.inserts).toHaveBeenCalledTimes(1)
	})
	it('serializes overlapping admission around the last available session', async () => {
		const f = await fixture(19)
		const results = await Promise.all(Array.from({ length: 10 }, () => f.create()))
		expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1)
		expect(results.filter((r) => r.statusCode === 429)).toHaveLength(9)
		expect(f.db.transaction).toHaveBeenCalledTimes(10)
		expect(f.lock).toHaveBeenCalledTimes(10)
		expect(f.inserts).toHaveBeenCalledTimes(1)
	})
})
