import { useEffect, useRef, useState } from 'react'
import type { SyncConflict } from '../components/content/sync-conflicts-dialog'
import { api } from './api-client'

export interface ExternalSyncStatus {
	enabled: boolean
	intervalMs: number
	lastSyncedAt: string | null
	lastAttemptAt: string | null
	error: string | null
	conflicts: SyncConflict[]
}

const IDLE_MS = 2 * 60_000
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'] as const

/** Read sync results and keep only the currently viewed collection active. */
export function useExternalSyncStatus(
	collectionId?: string,
	contentId?: string,
	onUpdate?: (status: ExternalSyncStatus) => void,
) {
	const [state, setState] = useState<{ key: string; status: ExternalSyncStatus } | null>(null)
	const callback = useRef(onUpdate)
	callback.current = onUpdate
	const key = `${collectionId}:${contentId ?? ''}`
	useEffect(() => {
		if (!collectionId) return
		let cancelled = false
		let pending = false
		let lastActivity = Date.now()
		const poll = async () => {
			if (
				cancelled ||
				pending ||
				document.visibilityState === 'hidden' ||
				Date.now() - lastActivity >= IDLE_MS
			)
				return
			pending = true
			try {
				const query = contentId ? `?contentId=${encodeURIComponent(contentId)}` : ''
				const status = await api.get<ExternalSyncStatus>(
					`/api/v1/collections/${collectionId}/sync-status${query}`,
				)
				if (cancelled) return
				setState({ key, status })
				callback.current?.(status)
			} catch {
				// Keep the last known warning through transient read failures.
			} finally {
				pending = false
			}
		}
		const onActivity = () => {
			const wasIdle = Date.now() - lastActivity >= IDLE_MS
			lastActivity = Date.now()
			if (wasIdle) void poll()
		}
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return
			lastActivity = Date.now()
			void poll()
		}
		for (const event of ACTIVITY_EVENTS) {
			document.addEventListener(event, onActivity, { passive: true, capture: true })
		}
		document.addEventListener('visibilitychange', onVisible)
		void poll()
		const timer = window.setInterval(poll, 10_000)
		return () => {
			cancelled = true
			window.clearInterval(timer)
			for (const event of ACTIVITY_EVENTS) {
				document.removeEventListener(event, onActivity, true)
			}
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [collectionId, contentId, key])
	return state?.key === key ? state.status : null
}
