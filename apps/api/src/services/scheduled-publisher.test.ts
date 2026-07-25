import { validateSchedule } from '@innolope/config'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishDueContent } from './scheduled-publisher.js'

const syncExternalStatus = vi.hoisted(() => vi.fn())
vi.mock('./external-content.js', () => ({ syncExternalStatus }))

type Row = {
	id: string
	projectId: string
	collectionId: string
	externalId: string | null
	slug: string
	status: string
	publishedAt: Date | null
}

/** Order of operations recorded across the fake db + external sync. */
let calls: string[]

/**
 * Minimal stand-in for the drizzle fluent builders the publisher uses:
 * `select().from().where().orderBy().limit()` and
 * `update().set().where().returning()`.
 */
function fakeApp(due: Row[], updateResult: (row: Row) => Row[]) {
	const emitted: Array<Record<string, unknown>> = []
	const app = {
		db: {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({ limit: async () => due }),
					}),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: () => ({
						returning: async () => {
							calls.push(`update:${JSON.stringify(Object.keys(values).sort())}`)
							return updateResult(due[0])
						},
					}),
				}),
			}),
		},
		log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
		events: {
			emit: (e: Record<string, unknown>) => {
				calls.push('emit')
				emitted.push(e)
			},
		},
	} as unknown as FastifyInstance
	return { app, emitted }
}

const row: Row = {
	id: 'c1',
	projectId: 'p1',
	collectionId: 'col1',
	externalId: 'ext1',
	slug: 'hello',
	status: 'scheduled',
	publishedAt: new Date('2020-01-01T09:00:00Z'),
}

describe('publishDueContent', () => {
	beforeEach(() => {
		calls = []
		syncExternalStatus.mockReset()
		syncExternalStatus.mockImplementation(async () => {
			calls.push('external')
		})
	})

	it('syncs the external row before flipping the local status', async () => {
		const { app } = fakeApp([row], (r) => [{ ...r, status: 'published' }])
		await expect(publishDueContent(app)).resolves.toBe(1)
		expect(calls[0]).toBe('external')
		expect(calls[1]).toMatch(/^update:/)
	})

	it('publishes without rewriting publishedAt', async () => {
		const { app } = fakeApp([row], (r) => [{ ...r, status: 'published' }])
		await publishDueContent(app)
		const update = calls.find((c) => c.startsWith('update:'))
		expect(update).toBe('update:["status","updatedAt"]')
	})

	it('emits content:published with the scheduled marker', async () => {
		const { app, emitted } = fakeApp([row], (r) => [{ ...r, status: 'published' }])
		await publishDueContent(app)
		expect(emitted).toHaveLength(1)
		expect(emitted[0]).toMatchObject({
			type: 'content:published',
			data: { id: 'c1', slug: 'hello', projectId: 'p1', scheduled: true },
		})
	})

	it('leaves the record scheduled when the external sync fails', async () => {
		syncExternalStatus.mockRejectedValueOnce(new Error('mongo down'))
		const { app, emitted } = fakeApp([row], (r) => [{ ...r, status: 'published' }])
		await expect(publishDueContent(app)).resolves.toBe(0)
		expect(calls.some((c) => c.startsWith('update:'))).toBe(false)
		expect(emitted).toHaveLength(0)
	})

	it('emits nothing when another instance already claimed the row', async () => {
		const { app, emitted } = fakeApp([row], () => [])
		await expect(publishDueContent(app)).resolves.toBe(0)
		expect(emitted).toHaveLength(0)
	})
})

describe('validateSchedule', () => {
	it('ignores every status but scheduled', () => {
		expect(validateSchedule('draft', undefined)).toBeNull()
		expect(validateSchedule('published', undefined)).toBeNull()
	})

	it('requires a publish date when scheduling', () => {
		expect(validateSchedule('scheduled', undefined)).toMatch(/publish date/i)
		expect(validateSchedule('scheduled', null)).toMatch(/publish date/i)
	})

	it('rejects an unparseable date', () => {
		expect(validateSchedule('scheduled', 'soon')).toMatch(/valid date/i)
	})

	it('accepts a valid date, past or future', () => {
		expect(validateSchedule('scheduled', new Date(Date.now() + 3_600_000))).toBeNull()
		// A past date is legal — the publisher picks it up on the next tick, which is
		// how "publish as soon as possible" is expressed.
		expect(validateSchedule('scheduled', '2020-01-01T00:00:00.000Z')).toBeNull()
	})
})
