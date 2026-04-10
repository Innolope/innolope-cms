import { createFileRoute, Link, Outlet, useMatches } from '@tanstack/react-router'
import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api-client'
import { useLicense, hasFeature, ProBadge, UpgradePrompt } from '../components/license-gate'

export const Route = createFileRoute('/content')({
	component: ContentLayout,
})

function ContentLayout() {
	const matches = useMatches()
	const hasChild = matches.some((m) => m.id === '/content/$id')

	if (hasChild) return <Outlet />
	return <ContentList />
}

interface ContentItem {
	id: string
	slug: string
	status: 'draft' | 'pending_review' | 'published' | 'archived'
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
	pending_review: 'bg-surface-alt text-text',
	published: 'bg-surface-alt text-text',
	archived: 'bg-surface-alt text-text-muted',
}

const STATUS_LABELS: Record<string, string> = {
	draft: 'draft',
	pending_review: 'pending review',
	published: 'published',
	archived: 'archived',
}

function ContentList() {
	const license = useLicense()
	const showReviewQueue = hasFeature(license, 'review-workflows')

	const [tab, setTab] = useState<'all' | 'review'>('all')
	const [items, setItems] = useState<ContentItem[]>([])
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(1)
	const [loading, setLoading] = useState(true)
	const [search, setSearch] = useState('')
	const [statusFilter, setStatusFilter] = useState<string>('')

	// Review queue state
	const [reviewItems, setReviewItems] = useState<ContentItem[]>([])
	const [reviewTotal, setReviewTotal] = useState(0)
	const [reviewPage, setReviewPage] = useState(1)
	const [reviewLoading, setReviewLoading] = useState(false)

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

	const fetchReviewQueue = useCallback(() => {
		setReviewLoading(true)
		api.get<{ data: ContentItem[]; pagination: { total: number } }>(`/api/v1/content/review-queue?page=${reviewPage}&limit=25`)
			.then((res) => {
				setReviewItems(res.data)
				setReviewTotal(res.pagination.total)
			})
			.catch(() => {})
			.finally(() => setReviewLoading(false))
	}, [reviewPage])

	useEffect(() => {
		if (tab === 'review') fetchReviewQueue()
	}, [tab, fetchReviewQueue])

	const approveItem = async (id: string) => {
		await api.post(`/api/v1/content/${id}/approve`, {})
		fetchReviewQueue()
	}

	const rejectItem = async (id: string) => {
		const reason = prompt('Rejection reason (optional):')
		await api.post(`/api/v1/content/${id}/reject`, { reason: reason || undefined })
		fetchReviewQueue()
	}

	return (
		<div className="p-8">
			<div className="flex items-center justify-between mb-6">
				<h2 className="text-2xl font-bold">Content</h2>
				<Link
					to="/content/$id"
					params={{ id: 'new' }}
					className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px transition-colors"
				>
					New Content
				</Link>
			</div>

			{/* Tabs */}
			<div className="flex gap-1 mb-4 border-b border-border">
				<button
					type="button"
					onClick={() => setTab('all')}
					className={`px-3 py-2 text-sm font-medium -mb-px transition-colors ${
						tab === 'all'
							? 'border-b-2 border-text text-text'
							: 'text-text-secondary hover:text-text'
					}`}
				>
					All Content
				</button>
				<button
					type="button"
					onClick={() => setTab('review')}
					className={`px-3 py-2 text-sm font-medium -mb-px transition-colors flex items-center ${
						tab === 'review'
							? 'border-b-2 border-text text-text'
							: 'text-text-secondary hover:text-text'
					}`}
				>
					Review Queue
					{showReviewQueue && reviewTotal > 0 && (
						<span className="ml-1.5 px-1.5 py-0.5 bg-surface-alt rounded-full text-xs">{reviewTotal}</span>
					)}
					{!showReviewQueue && <ProBadge />}
				</button>
			</div>

			{tab === 'all' ? (
				<>
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
							<option value="pending_review">Pending Review</option>
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
													{STATUS_LABELS[item.status] || item.status}
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
				</>
			) : !showReviewQueue ? (
				<UpgradePrompt feature="Review Workflows" plan="Pro" />
			) : (
				/* Review Queue Tab */
				<div className="rounded-lg border border-border">
					{reviewLoading ? (
						<div className="p-8 text-center text-text-secondary text-sm">Loading...</div>
					) : reviewItems.length === 0 ? (
						<div className="p-8 text-center text-text-secondary text-sm">
							No content pending review.
						</div>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-text-secondary border-b border-border">
									<th className="px-4 py-3 font-medium">Title</th>
									<th className="px-4 py-3 font-medium">Slug</th>
									<th className="px-4 py-3 font-medium">Updated</th>
									<th className="px-4 py-3 font-medium text-right">Actions</th>
								</tr>
							</thead>
							<tbody>
								{reviewItems.map((item) => (
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
										<td className="px-4 py-3 text-text-secondary">
											{new Date(item.updatedAt).toLocaleDateString()}
										</td>
										<td className="px-4 py-3 text-right">
											<div className="flex gap-2 justify-end">
												<button
													type="button"
													onClick={() => approveItem(item.id)}
													className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px"
												>
													Approve
												</button>
												<button
													type="button"
													onClick={() => rejectItem(item.id)}
													className="px-3 py-1 bg-btn-secondary text-text-secondary rounded text-xs hover:bg-btn-secondary-hover active:translate-x-px active:translate-y-px"
												>
													Reject
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}

					{reviewTotal > 25 && (
						<div className="flex items-center justify-between p-4 border-t border-border text-sm text-text-secondary">
							<span>
								{reviewTotal} items — page {reviewPage}
							</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => setReviewPage((p) => Math.max(1, p - 1))}
									disabled={reviewPage === 1}
									className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30"
								>
									Previous
								</button>
								<button
									type="button"
									onClick={() => setReviewPage((p) => p + 1)}
									disabled={reviewItems.length < 25}
									className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30"
								>
									Next
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
