import { createFileRoute, Outlet, useNavigate, useLocation } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCollections } from '../lib/collections'

export const Route = createFileRoute('/collections')({
	component: CollectionsLayout,
})

function CollectionsLayout() {
	const location = useLocation()
	const navigate = useNavigate()
	const { collections, loading } = useCollections()

	// Redirect bare /collections to first collection or /collections/new
	useEffect(() => {
		if (location.pathname === '/collections' && !loading) {
			if (collections.length > 0) {
				navigate({ to: `/collections/${collections[0].slug}` })
			} else {
				navigate({ to: '/collections/new' })
			}
		}
	}, [location.pathname, collections, loading, navigate])

	return <Outlet />
}
