import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { api } from './api-client'
import { useAuth } from './auth'

interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
	options?: string[]
}

export interface CollectionWithCount {
	id: string
	name: string
	slug: string
	description: string | null
	fields: CollectionField[]
	createdAt: string
	contentCount: number
}

interface CollectionsContextValue {
	collections: CollectionWithCount[]
	loading: boolean
	refreshCollections: () => Promise<void>
	getCollectionBySlug: (slug: string) => CollectionWithCount | undefined
	getCollectionById: (id: string) => CollectionWithCount | undefined
}

const CollectionsContext = createContext<CollectionsContextValue>({
	collections: [],
	loading: true,
	refreshCollections: async () => {},
	getCollectionBySlug: () => undefined,
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

	const getCollectionBySlug = useCallback(
		(slug: string) => collections.find((c) => c.slug === slug),
		[collections],
	)

	const getCollectionById = useCallback(
		(id: string) => collections.find((c) => c.id === id),
		[collections],
	)

	return (
		<CollectionsContext.Provider
			value={{ collections, loading, refreshCollections: fetchCollections, getCollectionBySlug, getCollectionById }}
		>
			{children}
		</CollectionsContext.Provider>
	)
}

export function useCollections() {
	return useContext(CollectionsContext)
}
