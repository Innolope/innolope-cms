import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	externalSyncIntervalMs,
	initExternalSyncWorker,
	markExternalSyncActive,
	syncExternalCollections,
} from './external-sync-worker.js'

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubEnv('NODE_ENV', 'production')
	vi.stubEnv('EXTERNAL_SYNC_INTERVAL_MS', '10000')
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

function fakeApp(result: Promise<unknown[]> = Promise.resolve([])) {
	const select = vi.fn()
	const query = {
		from: () => query,
		innerJoin: () => query,
		leftJoin: () => query,
		where: () => query,
		orderBy: () => result,
	}
	select.mockReturnValue(query)
	const close: Array<() => Promise<void>> = []
	const app = {
		db: { select },
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		addHook: (_: string, fn: () => Promise<void>) => close.push(fn),
	} as unknown as FastifyInstance
	return { app, select, close }
}

describe('regular external sync scheduling', () => {
	it('makes no database queries without viewers, including after a restart', async () => {
		const { app, select, close } = fakeApp()
		initExternalSyncWorker(app)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(select).not.toHaveBeenCalled()
		await close[0]()
	})
	it('expires idle viewers, renews active ones and resumes after a new visit', async () => {
		const { app, select } = fakeApp()
		markExternalSyncActive(app, 'active')
		await vi.advanceTimersByTimeAsync(40_000)
		markExternalSyncActive(app, 'active')
		await vi.advanceTimersByTimeAsync(40_000)
		await syncExternalCollections(app)
		expect(select).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(5_000)
		await syncExternalCollections(app)
		expect(select).toHaveBeenCalledTimes(2)
		markExternalSyncActive(app, 'active')
		await syncExternalCollections(app)
		expect(select).toHaveBeenCalledTimes(4)
	})
	it('skips a queued collection when its viewer expires during the selection query', async () => {
		let resolve!: (rows: unknown[]) => void
		const pending = new Promise<unknown[]>((r) => {
			resolve = r
		})
		const { app, select } = fakeApp(pending)
		markExternalSyncActive(app, 'active')
		const scan = syncExternalCollections(app)
		await vi.advanceTimersByTimeAsync(45_000)
		resolve([
			{
				collection: { id: 'active', externalTable: 'posts' },
				settings: {
					externalDb: { type: 'mongodb', connectionString: 'mongodb://synthetic.example.test' },
				},
			},
		])
		await scan
		expect(select).toHaveBeenCalledTimes(2)
		expect(app.log.warn).not.toHaveBeenCalled()
	})
	it('keeps viewer activity scoped to each API instance', async () => {
		const active = fakeApp()
		const idle = fakeApp()
		markExternalSyncActive(active.app, 'active')
		await syncExternalCollections(idle.app)
		expect(idle.select).not.toHaveBeenCalled()
		await syncExternalCollections(active.app)
		expect(active.select).toHaveBeenCalledTimes(2)
	})
	it('runs every 10 seconds and stops on shutdown', async () => {
		const { app, select, close } = fakeApp()
		markExternalSyncActive(app, 'active')
		initExternalSyncWorker(app)
		await vi.advanceTimersByTimeAsync(9999)
		expect(select).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(select).toHaveBeenCalledTimes(2) // outer query + active-import subquery
		await vi.advanceTimersByTimeAsync(10_000)
		expect(select).toHaveBeenCalledTimes(4)
		await close[0]()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(select).toHaveBeenCalledTimes(4)
	})
	it('does not overlap a slow scan, and waits for it on shutdown', async () => {
		let resolve!: (rows: unknown[]) => void
		const pending = new Promise<unknown[]>((r) => {
			resolve = r
		})
		const { app, select, close } = fakeApp(pending)
		markExternalSyncActive(app, 'active')
		initExternalSyncWorker(app)
		await vi.advanceTimersByTimeAsync(40_000)
		expect(select).toHaveBeenCalledTimes(2)
		let stopped = false
		const stop = close[0]().then(() => {
			stopped = true
		})
		await Promise.resolve()
		expect(stopped).toBe(false)
		resolve([])
		await stop
		expect(stopped).toBe(true)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(select).toHaveBeenCalledTimes(2)
	})
	it('supports a configurable interval and explicit disable', async () => {
		vi.stubEnv('EXTERNAL_SYNC_INTERVAL_MS', '25000')
		const configured = fakeApp()
		markExternalSyncActive(configured.app, 'active')
		initExternalSyncWorker(configured.app)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(configured.select).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(15_000)
		expect(configured.select).toHaveBeenCalledTimes(2)
		await configured.close[0]()
		vi.stubEnv('EXTERNAL_SYNC_INTERVAL_MS', '0')
		const disabled = fakeApp()
		initExternalSyncWorker(disabled.app)
		expect(disabled.close).toHaveLength(0)
		expect(externalSyncIntervalMs()).toBe(0)
	})
	it.each([
		'',
		'NaN',
		'-1',
		'10',
		'1000.1',
		'2147483648',
	])('uses a safe default for %s', (value) => {
		vi.stubEnv('EXTERNAL_SYNC_INTERVAL_MS', value)
		// Empty means unset/default, rather than silently disabling sync.
		expect(externalSyncIntervalMs()).toBe(10_000)
	})
})
