import { useCallback, useEffect, useState } from 'react'

const STORAGE_PREFIX = 'columns:'

interface StoredConfig {
	visible: string[] // ordered list of visible column ids
}

function load(key: string): StoredConfig | null {
	try {
		const raw = localStorage.getItem(key)
		if (!raw) return null
		const parsed = JSON.parse(raw)
		if (!parsed || !Array.isArray(parsed.visible)) return null
		return { visible: parsed.visible.filter((v: unknown): v is string => typeof v === 'string') }
	} catch {
		return null
	}
}

function save(key: string, cfg: StoredConfig) {
	try {
		localStorage.setItem(key, JSON.stringify(cfg))
	} catch {}
}

/**
 * Tracks which columns are visible and their order, persisted to localStorage per collection.
 *
 * `available` is the full set of column ids the schema offers.
 * `defaults` is what newcomers see if they have no stored preference.
 * `pinned` is column ids that cannot be hidden (e.g. title — needed for navigation).
 */
export function useColumnConfig(opts: {
	collectionId: string
	available: string[]
	defaults: string[]
	pinned?: string[]
}) {
	const { collectionId, available, defaults, pinned = [] } = opts
	const key = STORAGE_PREFIX + collectionId

	const reconcile = useCallback(
		(visible: string[]): string[] => {
			const availableSet = new Set(available)
			const seen = new Set<string>()
			const out: string[] = []
			for (const p of pinned) {
				if (availableSet.has(p) && !seen.has(p)) {
					out.push(p)
					seen.add(p)
				}
			}
			for (const id of visible) {
				if (availableSet.has(id) && !seen.has(id)) {
					out.push(id)
					seen.add(id)
				}
			}
			return out
		},
		[available, pinned],
	)

	const initial = useCallback((): string[] => {
		const stored = load(key)
		const base = stored ? stored.visible : defaults
		return reconcile(base)
	}, [key, defaults, reconcile])

	const [visible, setVisibleState] = useState<string[]>(initial)

	// Re-initialize when the collection changes
	useEffect(() => {
		setVisibleState(initial())
	}, [initial])

	const setVisible = useCallback(
		(next: string[]) => {
			const reconciled = reconcile(next)
			setVisibleState(reconciled)
			save(key, { visible: reconciled })
		},
		[key, reconcile],
	)

	const toggle = useCallback(
		(id: string) => {
			if (pinned.includes(id)) return
			setVisible(visible.includes(id) ? visible.filter((v) => v !== id) : [...visible, id])
		},
		[visible, setVisible, pinned],
	)

	const move = useCallback(
		(id: string, direction: -1 | 1) => {
			const idx = visible.indexOf(id)
			if (idx < 0) return
			const swap = idx + direction
			if (swap < 0 || swap >= visible.length) return
			// Don't move a column above pinned columns
			if (pinned.includes(visible[swap])) return
			const next = [...visible]
			;[next[idx], next[swap]] = [next[swap], next[idx]]
			setVisible(next)
		},
		[visible, setVisible, pinned],
	)

	const reset = useCallback(() => {
		try {
			localStorage.removeItem(key)
		} catch {}
		setVisibleState(reconcile(defaults))
	}, [key, defaults, reconcile])

	return { visible, setVisible, toggle, move, reset, pinned }
}
