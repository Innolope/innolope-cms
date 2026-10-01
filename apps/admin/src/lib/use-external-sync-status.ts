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

/** Read server sync results without starting a sync from the browser. */
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
		const poll = async () => {
			if (pending || document.visibilityState === 'hidden') return
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
		void poll()
		const timer = window.setInterval(poll, 10_000)
		return () => {
			cancelled = true
			window.clearInterval(timer)
		}
	}, [collectionId, contentId, key])
	return state?.key === key ? state.status : null
}
