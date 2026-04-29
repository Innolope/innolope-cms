import { useCallback, useEffect, useState } from 'react'

const PREFIX = 'f.'

export type FilterValue = string | { from?: string; to?: string }

export type FilterMap = Record<string, FilterValue>

function readFromUrl(): FilterMap {
	const params = new URLSearchParams(window.location.search)
	const out: FilterMap = {}
	for (const [k, v] of params) {
		if (!k.startsWith(PREFIX)) continue
		const id = k.slice(PREFIX.length)
		if (id.endsWith('.from') || id.endsWith('.to')) {
			const baseId = id.slice(0, -5)
			const side = id.endsWith('.from') ? 'from' : 'to'
			const existing = out[baseId]
			const range = existing && typeof existing === 'object' ? existing : {}
			out[baseId] = { ...range, [side]: v }
		} else {
			out[id] = v
		}
	}
	return out
}

function writeToUrl(filters: FilterMap) {
	const url = new URL(window.location.href)
	// Strip existing filter params
	for (const key of Array.from(url.searchParams.keys())) {
		if (key.startsWith(PREFIX)) url.searchParams.delete(key)
	}
	// Re-write
	for (const [id, val] of Object.entries(filters)) {
		if (typeof val === 'string') {
			if (val !== '') url.searchParams.set(PREFIX + id, val)
		} else {
			if (val.from) url.searchParams.set(PREFIX + id + '.from', val.from)
			if (val.to) url.searchParams.set(PREFIX + id + '.to', val.to)
		}
	}
	window.history.replaceState({}, '', url.toString())
}

/**
 * Filter state in URL query params, prefixed with `f.`.
 * Date ranges use `f.<id>.from` / `f.<id>.to`.
 *
 * Reads on mount + on popstate; writes on every change so URLs stay shareable.
 */
export function useUrlFilters() {
	const [filters, setFiltersState] = useState<FilterMap>(() => readFromUrl())

	useEffect(() => {
		const handler = () => setFiltersState(readFromUrl())
		window.addEventListener('popstate', handler)
		return () => window.removeEventListener('popstate', handler)
	}, [])

	const setFilters = useCallback((next: FilterMap | ((prev: FilterMap) => FilterMap)) => {
		setFiltersState((prev) => {
			const value = typeof next === 'function' ? (next as (p: FilterMap) => FilterMap)(prev) : next
			writeToUrl(value)
			return value
		})
	}, [])

	const setFilter = useCallback(
		(id: string, value: FilterValue | undefined) => {
			setFilters((prev) => {
				const out = { ...prev }
				if (value === undefined || value === '' || (typeof value === 'object' && !value.from && !value.to)) {
					delete out[id]
				} else {
					out[id] = value
				}
				return out
			})
		},
		[setFilters],
	)

	const clearAll = useCallback(() => setFilters({}), [setFilters])

	return { filters, setFilter, setFilters, clearAll }
}
