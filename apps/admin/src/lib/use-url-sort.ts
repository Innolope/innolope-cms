import { useCallback, useEffect, useState } from 'react'

export type SortDir = 'asc' | 'desc'

export interface SortState {
	/** Backend `sortBy` value — a real column or `meta:<field>`. */
	key: string
	dir: SortDir
}

const DEFAULT_SORT: SortState = { key: 'createdAt', dir: 'desc' }

function readFromUrl(): SortState {
	const params = new URLSearchParams(window.location.search)
	const key = params.get('sort')
	const dir = params.get('dir')
	return { key: key || DEFAULT_SORT.key, dir: dir === 'asc' ? 'asc' : 'desc' }
}

function writeToUrl(sort: SortState) {
	const url = new URL(window.location.href)
	// The default (createdAt desc) is implicit on the server, so leave it out of the URL.
	if (sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir) {
		url.searchParams.delete('sort')
		url.searchParams.delete('dir')
	} else {
		url.searchParams.set('sort', sort.key)
		url.searchParams.set('dir', sort.dir)
	}
	window.history.replaceState({}, '', url.toString())
}

/**
 * Sort state in URL query params (`sort` + `dir`).
 *
 * Reads on mount + on popstate; writes on every change so list URLs stay shareable.
 * Defaults to createdAt desc to match the backend default.
 */
export function useUrlSort() {
	const [sort, setSortState] = useState<SortState>(() => readFromUrl())

	useEffect(() => {
		const handler = () => setSortState(readFromUrl())
		window.addEventListener('popstate', handler)
		return () => window.removeEventListener('popstate', handler)
	}, [])

	const toggleSort = useCallback((key: string) => {
		setSortState((prev) => {
			// Same column → flip direction; a new column starts ascending.
			const next: SortState =
				prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
			writeToUrl(next)
			return next
		})
	}, [])

	return { sort, toggleSort }
}
