import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecordRefresh } from './use-record-refresh'

const base = { version: 1, updatedAt: '2026-10-01T10:00:00.000Z' }
const latest = { version: 2, updatedAt: '2026-10-01T10:01:00.000Z' }
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('10-second record checks', () => {
	const options = () => ({
		recordKey: 'project:collection:record',
		enabled: true,
		revision: base,
		dirty: false,
		busy: false,
		load: vi.fn().mockResolvedValue(latest),
		onRefresh: vi.fn(),
		onConflict: vi.fn(),
	})
	it('refreshes an untouched record after 10 seconds', async () => {
		const props = options()
		renderHook(() => useRecordRefresh(props))
		await act(() => vi.advanceTimersByTimeAsync(9999))
		expect(props.load).not.toHaveBeenCalled()
		await act(() => vi.advanceTimersByTimeAsync(1))
		expect(props.onRefresh).toHaveBeenCalledWith(latest)
		expect(props.onConflict).not.toHaveBeenCalled()
	})
	it('preserves edits begun while a check is in flight', async () => {
		const props = options()
		const request = deferred<typeof latest>()
		props.load.mockReturnValue(request.promise)
		const { rerender } = renderHook((p) => useRecordRefresh(p), { initialProps: props })
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		rerender({ ...props, dirty: true })
		await act(async () => request.resolve(latest))
		expect(props.onRefresh).not.toHaveBeenCalled()
		expect(props.onConflict).toHaveBeenCalledWith(latest)
	})
	it('drops a check that returns after a save advanced the revision', async () => {
		const props = options()
		const request = deferred<typeof latest>()
		props.load.mockReturnValue(request.promise)
		const { rerender } = renderHook((p) => useRecordRefresh(p), { initialProps: props })
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		rerender({ ...props, revision: { ...latest, version: 3 } })
		await act(async () => request.resolve(latest))
		expect(props.onRefresh).not.toHaveBeenCalled()
		expect(props.onConflict).not.toHaveBeenCalled()
	})
	it('does not apply a response to another record or after unmount', async () => {
		const props = options()
		const request = deferred<typeof latest>()
		props.load.mockReturnValue(request.promise)
		const { rerender, unmount } = renderHook((p) => useRecordRefresh(p), { initialProps: props })
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		rerender({ ...props, recordKey: 'another-record' })
		await act(async () => request.resolve(latest))
		expect(props.onRefresh).not.toHaveBeenCalled()
		unmount()
		await act(() => vi.advanceTimersByTimeAsync(30_000))
		expect(props.load).toHaveBeenCalledTimes(1)
	})
	it('does not overlap slow requests or poll while saving', async () => {
		const props = options()
		props.load.mockReturnValue(new Promise(() => {}))
		const { rerender } = renderHook((p) => useRecordRefresh(p), { initialProps: props })
		rerender({ ...props, busy: true })
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		expect(props.load).not.toHaveBeenCalled()
		rerender(props)
		await act(() => vi.advanceTimersByTimeAsync(30_000))
		expect(props.load).toHaveBeenCalledTimes(1)
	})
	it('detects status-only writes with an unchanged version number', async () => {
		const props = options()
		props.load.mockResolvedValue({ ...latest, version: base.version })
		renderHook(() => useRecordRefresh({ ...props, dirty: true }))
		await act(() => vi.advanceTimersByTimeAsync(10_000))
		expect(props.onConflict).toHaveBeenCalled()
	})
})
