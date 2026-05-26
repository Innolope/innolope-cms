import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api } from './api-client'
import { useAuth } from './auth'

interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
	options?: string[]
	relationTo?: string
	relationIsArray?: boolean
	ui?: {
		widget?: string
		placeholder?: string
		helpText?: string
		rows?: number
		separator?: 'enter' | 'comma' | 'both'
		readOnly?: boolean
		hidden?: boolean
		subFields?: CollectionField[]
	}
}

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
		if (!currentProject) {
			setCollections([])
			setLoading(false)
			return
		}
		try {
			const data = await api.get<CollectionWithCount[]>('/api/v1/collections/with-counts')
			setCollections(data)
		} catch {
			setCollections([])
		} finally {
			setLoading(false)
		}
	}, [currentProject])

	useEffect(() => {
		fetchCollections()
	}, [fetchCollections])

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
