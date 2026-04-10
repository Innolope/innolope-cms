import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/collections')({
	component: CollectionsLayout,
})

function CollectionsLayout() {
	const location = useLocation()
	const isChildRoute = location.pathname !== '/collections'

	if (isChildRoute) return <Outlet />
	return <CollectionsList />
}

interface Collection {
	id: string
	name: string
	slug: string
	description: string | null
	fields: CollectionField[]
	createdAt: string
}

interface CollectionField {
	name: string
	type: string
	required?: boolean
	localized?: boolean
	options?: string[]
}

function CollectionsList() {
	const [collections, setCollections] = useState<Collection[]>([])
	const [ready, setReady] = useState(false)

	const fetchCollections = () => {
		api.get<Collection[]>('/api/v1/collections')
			.then(setCollections)
			.catch(() => {})
			.finally(() => setReady(true))
	}

	useEffect(() => {
		fetchCollections()
	}, [])

	const deleteCollection = async (id: string) => {
		if (!confirm('Delete this collection and all its content?')) return
		await api.delete(`/api/v1/collections/${id}`)
		fetchCollections()
	}

	return (
		<div className="p-8 pt-5 flex flex-col h-full">
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-2xl font-bold">Collections</h2>
				{collections.length > 0 && (
					<Link
						to="/collections/$id"
						params={{ id: 'new' }}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px transition-colors"
					>
						New Collection
					</Link>
				)}
			</div>

			{!ready ? (
				<div />
			) : collections.length === 0 ? (
				<div className="flex flex-col items-center pt-[15vh] text-center">
					<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
						<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
							<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
						</svg>
					</div>
					<h3 className="font-semibold text-text mb-1">No collections yet</h3>
					<p className="text-sm text-text-secondary max-w-xs mb-5">
						Collections define content schemas — the structure and fields for each type of content you manage.
					</p>
					<Link
						to="/collections/$id"
						params={{ id: 'new' }}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
					>
						Create Collection
					</Link>
				</div>
			) : (
				<div className="space-y-3">
					{collections.map((col) => (
						<div
							key={col.id}
							className="rounded-lg border border-border p-4 hover:border-text-muted transition-colors"
						>
							<div className="flex items-start justify-between">
								<Link
									to="/collections/$id"
									params={{ id: col.id }}
									className="block"
								>
									<h3 className="font-semibold">{col.name}</h3>
									<p className="text-sm text-text-secondary mt-0.5">
										/{col.slug} — {col.fields.length} fields
									</p>
									{col.description && (
										<p className="text-sm text-text-secondary mt-1">{col.description}</p>
									)}
								</Link>
								<button
									type="button"
									onClick={() => deleteCollection(col.id)}
									className="text-xs text-danger hover:opacity-80"
								>
									Delete
								</button>
							</div>
							{col.fields.length > 0 && (
								<div className="flex flex-wrap gap-1.5 mt-3">
									{col.fields.map((f) => (
										<span
											key={f.name}
											className="px-2 py-0.5 bg-surface-alt rounded text-xs text-text-muted"
										>
											{f.name}
											<span className="text-text-secondary ml-1">{f.type}</span>
											{f.required && <span className="text-text-muted ml-0.5">*</span>}
										</span>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
