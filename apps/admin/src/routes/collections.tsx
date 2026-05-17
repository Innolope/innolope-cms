import { createFileRoute, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCollections } from '../lib/collections'

export const Route = createFileRoute('/collections')({
	component: CollectionsLayout,
})

function CollectionsLayout() {
	const location = useLocation()
	const navigate = useNavigate()
	const { collections, loading } = useCollections()

	// Redirect bare /collections to first collection or /collections/new.
	// The `media`-backed collection has its own /media tab, so it is skipped here.
	useEffect(() => {
		if (location.pathname === '/collections' && !loading) {
			const first = collections.find((col) => col.source !== 'media')
			if (first) {
				navigate({ to: `/collections/${first.name}` })
			} else {
				navigate({ to: '/collections/new' })
			}
		}
	}, [location.pathname, collections, loading, navigate])

	return <Outlet />
}
