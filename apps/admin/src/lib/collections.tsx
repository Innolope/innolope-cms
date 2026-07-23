import type { CollectionField } from '@innolope/config'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api } from './api-client'
import { useAuth } from './auth'

export interface CollectionWithCount {
	id: string
	name: string
	label: string
	description: string | null
	fields: CollectionField[]
	/** Name of the schema field used as the row label in lists + pickers. */
	titleField?: string | null
	source: string
	accessMode: string | null
	/** Source table backing an imported (external) collection. */
	externalTable?: string | null
	/**
	 * For an imported media library: the field holding the file path/URL, as
	 * recorded by the import wizard in `settings.externalDb.mediaStorage`. The
	 * server resolves this column to a servable URL on read, so the editor can
	 * render a thumbnail from it without guessing at the field name.
	 */
	mediaPathColumn?: string | null
	/**
	 * Whether that library's storage accepts uploads. Public / custom-URL libraries
	 * are reference-only, so the UI hides their upload controls.
	 */
	mediaWritable?: boolean
	/** Tri-state sidebar visibility. Defaults to 'auto'. */
	sidebarMode?: 'auto' | 'show' | 'hide'
	/** Server-computed: another collection references this one via a relation field. */
	isLinkedTarget?: boolean
	createdAt: string
	contentCount: number
}

interface CollectionsContextValue {
	collections: CollectionWithCount[]
	loading: boolean
	refreshCollections: () => Promise<void>
	getCollectionByName: (name: string) => CollectionWithCount | undefined
	getCollectionById: (id: string) => CollectionWithCount | undefined
}

const CollectionsContext = createContext<CollectionsContextValue>({
	collections: [],
	loading: true,
	refreshCollections: async () => {},
	getCollectionByName: () => undefined,
	getCollectionById: () => undefined,
})

export function CollectionsProvider({ children }: { children: ReactNode }) {
	const { currentProject } = useAuth()
	const [collections, setCollections] = useState<CollectionWithCount[]>([])
	const [loading, setLoading] = useState(true)

	const fetchCollections = useCallback(async () => {
		// No project yet — leave whatever's already in state alone. Previously this
		// cleared `collections` to []. When `currentProject` briefly flipped to null
		// during route transitions (e.g. settings re-resolving the project), the
		// sidebar's collection list got wiped and didn't repopulate because the
		// next fetch ran while the user was already on a route that did its own
		// data loading. Net result: empty COLLECTIONS section on /settings.
		if (!currentProject) {
			setLoading(false)
			return
		}
		try {
			const data = await api.get<CollectionWithCount[]>('/api/v1/collections/with-counts')
			setCollections(data)
		} catch {
			// Don't blow away a populated list on a transient fetch failure —
			// the next visibilitychange tick will retry. Just stop showing the
			// loading skeleton.
		} finally {
			setLoading(false)
		}
	}, [currentProject])

	useEffect(() => {
		fetchCollections()
	}, [fetchCollections])

	// If we ever land in a state where the project is known but the cache is
	// empty (e.g. after the protective change above swallowed a transient
	// failure on first mount), kick a refetch. Cheap insurance against the
	// "sidebar empty on /settings" symptom that prompted this fix.
	useEffect(() => {
		if (currentProject && collections.length === 0 && !loading) {
			fetchCollections()
		}
	}, [currentProject, collections.length, loading, fetchCollections])

	// Refresh on tab refocus for stale count mitigation
	useEffect(() => {
		const handler = () => {
			if (document.visibilityState === 'visible') fetchCollections()
		}
		document.addEventListener('visibilitychange', handler)
		return () => document.removeEventListener('visibilitychange', handler)
	}, [fetchCollections])

	const getCollectionByName = useCallback(
		(name: string) => collections.find((c) => c.name === name),
		[collections],
	)

	const getCollectionById = useCallback(
		(id: string) => collections.find((c) => c.id === id),
		[collections],
	)

	return (
		<CollectionsContext.Provider
			value={{
				collections,
				loading,
				refreshCollections: fetchCollections,
				getCollectionByName,
				getCollectionById,
			}}
		>
			{children}
		</CollectionsContext.Provider>
	)
}

export function useCollections() {
	return useContext(CollectionsContext)
}

/**
 * Whether a collection should appear in the admin sidebar based on its
 * `sidebarMode` + `isLinkedTarget`. Hoisted so the sidebar and any other
 * surface use exactly the same rule.
 */
export function isCollectionVisibleInSidebar(col: {
	source: string
	sidebarMode?: 'auto' | 'show' | 'hide'
	isLinkedTarget?: boolean
}): boolean {
	if (col.source === 'media') return false
	const mode = col.sidebarMode ?? 'auto'
	if (mode === 'hide') return false
	if (mode === 'show') return true
	// auto: hide if another collection references this one as a relation target.
	return !col.isLinkedTarget
}
