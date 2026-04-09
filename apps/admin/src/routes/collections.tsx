import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/collections')({
	component: CollectionsList,
})

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
	const [loading, setLoading] = useState(true)

	const fetchCollections = () => {
		setLoading(true)
		api.get<Collection[]>('/api/v1/collections')
			.then(setCollections)
			.catch(() => {})
			.finally(() => setLoading(false))
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
		<div className="p-8 max-w-4xl">
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-2xl font-bold">Collections</h2>
				<Link
					to="/collections/$id"
					params={{ id: 'new' }}
					className="px-4 py-2 bg-white text-black rounded-md text-sm font-medium hover:bg-zinc-200 transition-colors"
				>
					New Collection
				</Link>
			</div>

			{loading ? (
				<p className="text-zinc-500 text-sm">Loading...</p>
			) : collections.length === 0 ? (
				<div className="rounded-lg border border-zinc-800 p-8 text-center text-zinc-500 text-sm">
					No collections yet. Create one to start organizing content.
				</div>
			) : (
				<div className="space-y-3">
					{collections.map((col) => (
						<div
							key={col.id}
							className="rounded-lg border border-zinc-800 p-4 hover:border-zinc-600 transition-colors"
						>
							<div className="flex items-start justify-between">
								<Link
									to="/collections/$id"
									params={{ id: col.id }}
									className="block"
								>
									<h3 className="font-semibold">{col.name}</h3>
									<p className="text-sm text-zinc-500 mt-0.5">
										/{col.slug} — {col.fields.length} fields
									</p>
									{col.description && (
										<p className="text-sm text-zinc-600 mt-1">{col.description}</p>
									)}
								</Link>
								<button
									type="button"
									onClick={() => deleteCollection(col.id)}
									className="text-xs text-red-500 hover:text-red-400"
								>
									Delete
								</button>
							</div>
							{col.fields.length > 0 && (
								<div className="flex flex-wrap gap-1.5 mt-3">
									{col.fields.map((f) => (
										<span
											key={f.name}
											className="px-2 py-0.5 bg-zinc-800 rounded text-xs text-zinc-400"
										>
											{f.name}
											<span className="text-zinc-600 ml-1">{f.type}</span>
											{f.required && <span className="text-amber-500 ml-0.5">*</span>}
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
