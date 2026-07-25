import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startUpdateWatcher } from './build-version.js'

describe('startUpdateWatcher', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	const flush = async () => {
		// Let the async check() settle after a timer tick.
		await vi.advanceTimersByTimeAsync(0)
	}

	it('fires onUpdate once when the deployed id differs', async () => {
		const onUpdate = vi.fn()
		const stop = startUpdateWatcher({
			currentId: 'aaa',
			fetchId: async () => 'bbb',
			onUpdate,
			intervalMs: 1000,
		})
		await vi.advanceTimersByTimeAsync(1000)
		expect(onUpdate).toHaveBeenCalledTimes(1)

		// Later ticks and focus events must not repeat the news.
		await vi.advanceTimersByTimeAsync(5000)
		window.dispatchEvent(new Event('focus'))
		await flush()
		expect(onUpdate).toHaveBeenCalledTimes(1)
		stop()
	})

	it('stays quiet while the deployed id matches, then fires when it changes', async () => {
		let deployed = 'aaa'
		const onUpdate = vi.fn()
		const stop = startUpdateWatcher({
			currentId: 'aaa',
			fetchId: async () => deployed,
			onUpdate,
			intervalMs: 1000,
		})
		await vi.advanceTimersByTimeAsync(3000)
		expect(onUpdate).not.toHaveBeenCalled()

		deployed = 'ccc'
		await vi.advanceTimersByTimeAsync(1000)
		expect(onUpdate).toHaveBeenCalledTimes(1)
		stop()
	})

	it('checks when the tab regains focus, not only on the interval', async () => {
		const onUpdate = vi.fn()
		const stop = startUpdateWatcher({
			currentId: 'aaa',
			fetchId: async () => 'bbb',
			onUpdate,
			intervalMs: 60_000,
		})
		window.dispatchEvent(new Event('focus'))
		await flush()
		expect(onUpdate).toHaveBeenCalledTimes(1)
		stop()
	})

	it('ignores null ids (missing or unparseable version.json) and fetch errors', async () => {
		const onUpdate = vi.fn()
		let calls = 0
		const stop = startUpdateWatcher({
			currentId: 'aaa',
			fetchId: async () => {
				calls++
				if (calls === 1) return null
				throw new Error('network down')
			},
			onUpdate,
			intervalMs: 1000,
		})
		await vi.advanceTimersByTimeAsync(1000)
		// The second tick's fetch throws; the watcher must survive it silently.
		await vi.advanceTimersByTimeAsync(1000)
		expect(calls).toBe(2)
		expect(onUpdate).not.toHaveBeenCalled()
		stop()
	})

	it('does nothing after stop()', async () => {
		const onUpdate = vi.fn()
		const stop = startUpdateWatcher({
			currentId: 'aaa',
			fetchId: async () => 'bbb',
			onUpdate,
			intervalMs: 1000,
		})
		stop()
		await vi.advanceTimersByTimeAsync(5000)
		window.dispatchEvent(new Event('focus'))
		await flush()
		expect(onUpdate).not.toHaveBeenCalled()
	})
})
