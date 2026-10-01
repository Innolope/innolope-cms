import { useEffect, useRef } from 'react'

export interface RecordRevision {
	version: number
	updatedAt?: string | null
}

export function sameRevision(a: RecordRevision, b: RecordRevision): boolean {
	return a.version === b.version && (a.updatedAt ?? null) === (b.updatedAt ?? null)
}

/** Refresh an open editor without replacing a draft or applying an old response. */
export function useRecordRefresh<T extends RecordRevision>(options: {
	recordKey: string
	enabled: boolean
	revision: RecordRevision
	dirty: boolean
	busy: boolean
	load: () => Promise<T>
	onRefresh: (record: T) => void
	onConflict: (record: T) => void
}) {
	const current = useRef(options)
	current.current = options
	const { recordKey, enabled } = options
	useEffect(() => {
		if (!enabled) return
		let cancelled = false
		let pending = false
		const check = async () => {
			const before = current.current
			if (pending || before.busy || document.visibilityState === 'hidden') return
			pending = true
			try {
				const latest = await before.load()
				const now = current.current
				if (
					cancelled ||
					!now.enabled ||
					now.busy ||
					now.recordKey !== recordKey ||
					!sameRevision(before.revision, now.revision) ||
					sameRevision(latest, now.revision)
				)
					return
				if (now.dirty) now.onConflict(latest)
				else now.onRefresh(latest)
			} catch {
				// A transient read failure must not disturb the draft; retry next tick.
			} finally {
				pending = false
			}
		}
		const timer = window.setInterval(check, 10_000)
		return () => {
			cancelled = true
			window.clearInterval(timer)
		}
	}, [recordKey, enabled])
}
