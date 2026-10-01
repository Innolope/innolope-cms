import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api-client'
import { type ExternalSyncStatus, useExternalSyncStatus } from './use-external-sync-status'

vi.mock('./api-client', () => ({ api: { get: vi.fn() } }))
const status: ExternalSyncStatus = {
	enabled: true,
	intervalMs: 10000,
	lastAttemptAt: null,
	lastSyncedAt: null,
	error: null,
	conflicts: [],
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	vi.mocked(api.get).mockResolvedValue(status)
})
afterEach(() => vi.useRealTimers())

describe('background sync notices', () => {
	it('reads persisted state immediately and every 10 seconds without starting sync', async () => {
		const onUpdate = vi.fn()
		const { result } = renderHook(() => useExternalSyncStatus('a', undefined, onUpdate))
		await act(async () => {})
		expect(result.current).toEqual(status)
		expect(api.get).toHaveBeenCalledWith('/api/v1/collections/a/sync-status')
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		expect(api.get).toHaveBeenCalledTimes(2)
		expect(onUpdate).toHaveBeenCalledTimes(2)
	})
	it('shows only the current record conflicts and retains warnings through read failures', async () => {
		const warning = { ...status, error: 'Retrying' }
		vi.mocked(api.get).mockResolvedValueOnce(warning).mockRejectedValueOnce(new Error('Offline'))
		const { result } = renderHook(() => useExternalSyncStatus('a', 'one'))
		await act(async () => {})
		expect(api.get).toHaveBeenCalledWith('/api/v1/collections/a/sync-status?contentId=one')
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		expect(result.current).toEqual(warning)
	})
	it('ignores late responses from the previous collection and stops after unmount', async () => {
		let resolve!: (value: ExternalSyncStatus) => void
		vi.mocked(api.get).mockReturnValueOnce(
			new Promise((r) => {
				resolve = r
			}),
		)
		const onUpdate = vi.fn()
		const { result, rerender, unmount } = renderHook(
			(id) => useExternalSyncStatus(id, undefined, onUpdate),
			{ initialProps: 'a' },
		)
		rerender('b')
		await act(async () => {})
		await act(async () => resolve({ ...status, error: 'Old warning' }))
		expect(result.current).toEqual(status)
		expect(onUpdate).toHaveBeenCalledTimes(1)
		unmount()
		await act(() => vi.advanceTimersByTimeAsync(30_000))
		expect(api.get).toHaveBeenCalledTimes(2)
	})
	it('does not overlap slow status reads', async () => {
		vi.mocked(api.get).mockReturnValue(new Promise(() => {}))
		renderHook(() => useExternalSyncStatus('a'))
		await act(() => vi.advanceTimersByTimeAsync(30_000))
		expect(api.get).toHaveBeenCalledTimes(1)
	})
})
