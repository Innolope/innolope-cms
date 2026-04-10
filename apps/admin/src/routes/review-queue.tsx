import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'
import { useToast } from '../lib/toast'

export const Route = createFileRoute('/review-queue')({
	component: ReviewQueue,
})

interface ContentItem {
	id: string
	slug: string
	status: string
	metadata: Record<string, unknown>
	locale: string
	version: number
	createdAt: string
	updatedAt: string
}

interface ReviewResponse {
	data: ContentItem[]
	pagination: { page: number; limit: number; total: number; totalPages: number }
}

function ReviewQueue() {
	const toast = useToast()
	const [items, setItems] = useState<ContentItem[]>([])
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(1)
	const [loading, setLoading] = useState(true)

	const fetchQueue = () => {
		setLoading(true)
		api.get<ReviewResponse>(`/api/v1/content/review-queue?page=${page}&limit=25`)
			.then((res) => {
				setItems(res.data)
				setTotal(res.pagination.total)
			})
			.catch(() => {})
			.finally(() => setLoading(false))
	}

	useEffect(() => {
		fetchQueue()
	}, [page])

	const approve = async (id: string) => {
		try {
			await api.post(`/api/v1/content/${id}/approve`, {})
			fetchQueue()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Approve failed', 'error')
		}
	}

	const reject = async (id: string) => {
		const reason = prompt('Rejection reason (optional):')
		try {
			await api.post(`/api/v1/content/${id}/reject`, { reason: reason || undefined })
			fetchQueue()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Reject failed', 'error')
		}
	}

	return (
		<div className="p-8">
			<div className="mb-6">
				<h2 className="text-2xl font-bold">Review Queue</h2>
				<p className="text-sm text-text-secondary mt-1">Content awaiting editorial approval</p>
			</div>

			<div className="rounded-lg border border-border">
				{loading ? (
					<div className="p-8 text-center text-text-secondary text-sm">Loading...</div>
				) : items.length === 0 ? (
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
									<td className="px-4 py-3 text-text-secondary">
										{new Date(item.updatedAt).toLocaleDateString()}
									</td>
									<td className="px-4 py-3 text-right">
										<div className="flex gap-2 justify-end">
											<button
												type="button"
												onClick={() => approve(item.id)}
												className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover"
											>
												Approve
											</button>
											<button
												type="button"
												onClick={() => reject(item.id)}
												className="px-3 py-1 bg-btn-secondary rounded text-xs font-medium hover:bg-btn-secondary-hover"
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
