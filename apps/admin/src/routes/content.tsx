import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/content')({
	component: ContentList,
})

interface ContentItem {
	id: string
	slug: string
	status: 'draft' | 'published' | 'archived'
	metadata: Record<string, unknown>
	locale: string
	version: number
	createdAt: string
	updatedAt: string
}

interface ContentResponse {
	data: ContentItem[]
	pagination: { page: number; limit: number; total: number; totalPages: number }
}

const STATUS_STYLES: Record<string, string> = {
	draft: 'bg-surface-alt text-text-secondary',
	published: 'bg-surface-alt text-text',
	archived: 'bg-surface-alt text-text-muted',
}

function ContentList() {
	const [items, setItems] = useState<ContentItem[]>([])
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(1)
	const [loading, setLoading] = useState(true)
	const [search, setSearch] = useState('')
	const [statusFilter, setStatusFilter] = useState<string>('')

	useEffect(() => {
		const params = new URLSearchParams()
		params.set('page', String(page))
		params.set('limit', '25')
		if (search) params.set('search', search)
		if (statusFilter) params.set('status', statusFilter)

		setLoading(true)
		api.get<ContentResponse>(`/api/v1/content?${params}`)
			.then((res) => {
				setItems(res.data)
				setTotal(res.pagination.total)
			})
			.catch(() => {})
			.finally(() => setLoading(false))
	}, [page, search, statusFilter])

	return (
		<div className="p-8">
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-2xl font-bold">Content</h2>
				<Link
					to="/content/$id"
					params={{ id: 'new' }}
					className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover transition-colors"
				>
					New Content
				</Link>
			</div>

			<div className="flex gap-3 mb-4">
				<input
					type="text"
					placeholder="Search..."
					value={search}
					onChange={(e) => {
						setSearch(e.target.value)
						setPage(1)
					}}
					className="flex-1 px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
				/>
				<select
					value={statusFilter}
					onChange={(e) => {
						setStatusFilter(e.target.value)
						setPage(1)
					}}
					className="px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none"
				>
					<option value="">All statuses</option>
					<option value="draft">Draft</option>
					<option value="published">Published</option>
					<option value="archived">Archived</option>
				</select>
			</div>

			<div className="rounded-lg border border-border">
				{loading ? (
					<div className="p-8 text-center text-text-secondary text-sm">Loading...</div>
				) : items.length === 0 ? (
					<div className="p-8 text-center text-text-secondary text-sm">
						{search || statusFilter
							? 'No content matches your filters.'
							: 'No content yet. Create your first article.'}
					</div>
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-text-secondary border-b border-border">
								<th className="px-4 py-3 font-medium">Title</th>
								<th className="px-4 py-3 font-medium">Slug</th>
								<th className="px-4 py-3 font-medium">Status</th>
								<th className="px-4 py-3 font-medium">Updated</th>
							</tr>
						</thead>
						<tbody>
							{items.map((item) => (
								<tr
									key={item.id}
									className="border-b border-border hover:bg-surface-alt transition-colors"
								>
									<td className="px-4 py-3">
										<Link
											to="/content/$id"
											params={{ id: item.id }}
											className="hover:text-text transition-colors"
										>
											{(item.metadata?.title as string) || item.slug}
										</Link>
									</td>
									<td className="px-4 py-3 text-text-secondary font-mono text-xs">
										{item.slug}
									</td>
									<td className="px-4 py-3">
										<span
											className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLES[item.status] || ''}`}
										>
											{item.status}
										</span>
									</td>
									<td className="px-4 py-3 text-text-secondary">
										{new Date(item.updatedAt).toLocaleDateString()}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{total > 25 && (
				<div className="flex items-center justify-between mt-4 text-sm text-text-secondary">
					<span>
						{total} items — page {page}
					</span>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => setPage((p) => Math.max(1, p - 1))}
							disabled={page === 1}
							className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30"
						>
							Previous
						</button>
						<button
							type="button"
							onClick={() => setPage((p) => p + 1)}
							disabled={items.length < 25}
							className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30"
						>
							Next
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
