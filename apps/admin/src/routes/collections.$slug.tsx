import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router'
import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { api } from '../lib/api-client'
import { useCollections, type CollectionWithCount } from '../lib/collections'
import { useLicense, hasFeature, ProBadge, UpgradePrompt } from '../components/license-gate'
import { ColumnConfig, type ColumnOption } from '../components/column-config'
import { FilterBar, type FilterDescriptor } from '../components/filter-bar'
import { useUrlFilters, type FilterMap } from '../lib/use-url-filters'
import { useColumnConfig } from '../lib/use-column-config'
import { relativeTime, absoluteDate } from '../lib/relative-time'

export const Route = createFileRoute('/collections/$slug')({
	component: CollectionLayout,
})

function CollectionLayout() {
	const { slug } = Route.useParams()
	const location = useLocation()
	const isChildRoute = location.pathname !== `/collections/${slug}`

	if (isChildRoute) return <Outlet />
	return <CollectionContentList />
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
	publishedAt?: string | null
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

const STATUS_OPTIONS = [
	{ value: 'draft', label: 'Draft' },
	{ value: 'pending_review', label: 'Pending Review' },
	{ value: 'published', label: 'Published' },
	{ value: 'archived', label: 'Archived' },
]

interface ColumnDescriptor {
	id: string
	label: string
	render: (item: ContentItem, ctx: { slug: string }) => ReactNode
}

function buildColumns(collection: CollectionWithCount): ColumnDescriptor[] {
	const builtins: ColumnDescriptor[] = [
		{
			id: 'title',
			label: 'Title',
			render: (item, ctx) => (
				<Link
					to="/collections/$slug/$contentId"
					params={{ slug: ctx.slug, contentId: item.id }}
					className="hover:text-text transition-colors"
				>
					{(item.metadata?.title as string) || item.slug}
				</Link>
			),
		},
		{
			id: 'slug',
			label: 'Slug',
			render: (item) => <span className="text-text-secondary font-mono text-xs">{item.slug}</span>,
		},
		{
			id: 'status',
			label: 'Status',
			render: (item) => (
				<span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLES[item.status] || ''}`}>
					{STATUS_LABELS[item.status] || item.status}
				</span>
			),
		},
		{
			id: 'locale',
			label: 'Locale',
			render: (item) => <span className="text-text-secondary text-xs">{item.locale}</span>,
		},
		{
			id: 'updatedAt',
			label: 'Last edited',
			render: (item) => {
				const created = new Date(item.createdAt).getTime()
				const updated = new Date(item.updatedAt).getTime()
				const neverEdited = Math.abs(updated - created) < 5_000
				return (
					<span
						className={neverEdited ? 'text-text-muted italic' : 'text-text-secondary'}
						title={neverEdited
							? `Imported ${absoluteDate(item.updatedAt)} — never edited`
							: absoluteDate(item.updatedAt)}
					>
						{relativeTime(item.updatedAt)}
					</span>
				)
			},
		},
		{
			id: 'createdAt',
			label: 'Created',
			render: (item) => (
				<span className="text-text-secondary" title={absoluteDate(item.createdAt)}>
					{relativeTime(item.createdAt)}
				</span>
			),
		},
		{
			id: 'publishedAt',
			label: 'Published',
			render: (item) =>
				item.publishedAt ? (
					<span className="text-text-secondary" title={absoluteDate(item.publishedAt)}>
						{relativeTime(item.publishedAt)}
					</span>
				) : (
					<span className="text-text-muted">—</span>
				),
		},
	]

	const metadataCols: ColumnDescriptor[] = (collection.fields || []).map((f) => ({
		id: `meta:${f.name}`,
		label: f.name,
		render: (item) => renderMetadataValue(item.metadata?.[f.name]),
	}))

	return [...builtins, ...metadataCols]
}

function renderMetadataValue(value: unknown): ReactNode {
	if (value === null || value === undefined || value === '') return <span className="text-text-muted">—</span>
	if (typeof value === 'boolean') return <span className="text-text-secondary">{value ? '✓' : '—'}</span>
	if (Array.isArray(value)) return <span className="text-text-secondary text-xs">{value.join(', ')}</span>
	if (typeof value === 'object') return <span className="text-text-muted text-xs italic">[object]</span>
	return <span className="text-text-secondary">{String(value)}</span>
}

function buildFilters(collection: CollectionWithCount): FilterDescriptor[] {
	const builtins: FilterDescriptor[] = [
		{ id: 'status', label: 'Status', type: 'enum', options: STATUS_OPTIONS },
		{ id: 'locale', label: 'Locale', type: 'text' },
		{ id: 'updatedAt', label: 'Last edited', type: 'date-range' },
		{ id: 'createdAt', label: 'Created', type: 'date-range' },
		{ id: 'publishedAt', label: 'Published', type: 'date-range' },
	]
	const metadata: FilterDescriptor[] = (collection.fields || []).map((f) => {
		if (f.options && f.options.length > 0) {
			return {
				id: `meta:${f.name}`,
				label: f.name,
				type: 'enum',
				options: f.options.map((o) => ({ value: o, label: o })),
			}
		}
		return { id: `meta:${f.name}`, label: f.name, type: 'text' }
	})
	return [...builtins, ...metadata]
}

function filtersToQueryParams(filters: FilterMap): URLSearchParams {
	const out = new URLSearchParams()
	const metadata: Record<string, string> = {}
	for (const [id, value] of Object.entries(filters)) {
		if (id.startsWith('meta:')) {
			const key = id.slice(5)
			if (typeof value === 'string' && value) metadata[key] = value
			continue
		}
		if (id === 'status' && typeof value === 'string' && value) {
			out.set('status', value)
			continue
		}
		if (id === 'locale' && typeof value === 'string' && value) {
			out.set('locale', value)
			continue
		}
		if (id === 'updatedAt' && typeof value === 'object') {
			if (value.from) out.set('updatedFrom', value.from)
			if (value.to) out.set('updatedTo', value.to)
			continue
		}
		if (id === 'createdAt' && typeof value === 'object') {
			if (value.from) out.set('createdFrom', value.from)
			if (value.to) out.set('createdTo', value.to)
			continue
		}
		if (id === 'publishedAt' && typeof value === 'object') {
			if (value.from) out.set('publishedFrom', value.from)
			if (value.to) out.set('publishedTo', value.to)
		}
	}
	if (Object.keys(metadata).length > 0) out.set('metadata', JSON.stringify(metadata))
	return out
}

const DEFAULT_COLUMNS = ['title', 'slug', 'status', 'updatedAt']
const PINNED_COLUMNS = ['title']

function CollectionContentList() {
	const { slug } = Route.useParams()
	const { getCollectionByName } = useCollections()
	const collection = getCollectionByName(slug)
	const license = useLicense()
	const showReviewQueue = hasFeature(license, 'review-workflows')

	const [tab, setTabState] = useState<'all' | 'review'>(() => {
		const params = new URLSearchParams(window.location.search)
		return (params.get('tab') as 'all' | 'review') || 'all'
	})
	const setTab = (t: 'all' | 'review') => {
		setTabState(t)
		const url = new URL(window.location.href)
		url.searchParams.set('tab', t)
		window.history.replaceState({}, '', url.toString())
	}

	const [items, setItems] = useState<ContentItem[]>([])
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(1)
	const [ready, setReady] = useState(false)
	const [search, setSearch] = useState('')

	const { filters, setFilter, clearAll } = useUrlFilters()

	const allColumns: ColumnDescriptor[] = useMemo(
		() => (collection ? buildColumns(collection) : []),
		[collection],
	)
	const allFilters: FilterDescriptor[] = useMemo(
		() => (collection ? buildFilters(collection) : []),
		[collection],
	)

	const columnConfig = useColumnConfig({
		collectionId: collection?.id || '__none__',
		available: allColumns.map((c) => c.id),
		defaults: DEFAULT_COLUMNS,
		pinned: PINNED_COLUMNS,
	})

	const visibleColumns: ColumnDescriptor[] = useMemo(
		() => columnConfig.visible
			.map((id) => allColumns.find((c) => c.id === id))
			.filter((c): c is ColumnDescriptor => Boolean(c)),
		[columnConfig.visible, allColumns],
	)

	const columnOptions: ColumnOption[] = useMemo(
		() => allColumns.map((c) => ({ id: c.id, label: c.label })),
		[allColumns],
	)

	const [reviewItems, setReviewItems] = useState<ContentItem[]>([])
	const [reviewTotal, setReviewTotal] = useState(0)
	const [reviewPage, setReviewPage] = useState(1)
	const [reviewLoading, setReviewLoading] = useState(false)

	const filterQuery = useMemo(() => filtersToQueryParams(filters).toString(), [filters])
	const hasActiveFilters = Object.keys(filters).length > 0

	useEffect(() => {
		if (!collection) return
		const params = new URLSearchParams()
		params.set('page', String(page))
		params.set('limit', '25')
		params.set('collectionId', collection.id)
		if (search) params.set('search', search)
		// Merge active filters
		for (const [k, v] of new URLSearchParams(filterQuery)) params.set(k, v)

		api.get<ContentResponse>(`/api/v1/content?${params}`)
			.then((res) => {
				setItems(res.data)
				setTotal(res.pagination.total)
			})
			.catch(() => {})
			.finally(() => setReady(true))
	}, [page, search, filterQuery, collection])

	const fetchReviewQueue = useCallback(() => {
		if (!collection) return
		setReviewLoading(true)
		api.get<{ data: ContentItem[]; pagination: { total: number } }>(`/api/v1/content/review-queue?page=${reviewPage}&limit=25&collectionId=${collection.id}`)
			.then((res) => {
				setReviewItems(res.data)
				setReviewTotal(res.pagination.total)
			})
			.catch(() => {})
			.finally(() => setReviewLoading(false))
	}, [reviewPage, collection])

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

	if (!collection) {
		return (
			<div className="p-8 pt-5">
				<p className="text-text-secondary text-sm">Collection not found.</p>
			</div>
		)
	}

	const showToolbar = total > 0 || search || hasActiveFilters

	return (
		<div className="p-8 pt-5 flex flex-col h-full">
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-4">
					<h2 className="text-2xl font-bold">{collection.label}</h2>
					<div className="flex bg-surface rounded-lg p-0.5 border border-border">
						<button
							type="button"
							onClick={() => setTab('all')}
							className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
								tab === 'all' ? 'bg-surface-alt text-text' : 'text-text-secondary hover:text-text-muted'
							}`}
						>
							All
						</button>
						<button
							type="button"
							onClick={() => setTab('review')}
							className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center ${
								tab === 'review' ? 'bg-surface-alt text-text' : 'text-text-secondary hover:text-text-muted'
							}`}
						>
							Review
							{showReviewQueue && reviewTotal > 0 && (
								<span className="ml-1.5 px-1.5 py-0.5 bg-border rounded-full text-[10px]">{reviewTotal}</span>
							)}
							{!showReviewQueue && <ProBadge />}
						</button>
					</div>
				</div>
				{showToolbar && (
					<Link
						to="/collections/$slug/$contentId" params={{ slug, contentId: 'new' }}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px transition-colors"
					>
						New {collection.label.replace(/s$/, '')}
					</Link>
				)}
			</div>

			{tab === 'all' ? (
				<>
					{showToolbar && (
						<div className="flex flex-col gap-3 mb-4">
							<div className="flex gap-3 items-center">
								<input
									type="text"
									placeholder="Search..."
									value={search}
									onChange={(e) => { setSearch(e.target.value); setPage(1) }}
									className="flex-1 px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
								/>
								<ColumnConfig
									available={columnOptions}
									visible={columnConfig.visible}
									pinned={columnConfig.pinned}
									onToggle={columnConfig.toggle}
									onMove={columnConfig.move}
									onReset={columnConfig.reset}
								/>
							</div>
							<FilterBar
								available={allFilters}
								filters={filters}
								onChange={(id, value) => { setFilter(id, value); setPage(1) }}
								onClearAll={() => { clearAll(); setPage(1) }}
							/>
						</div>
					)}

					<div className={total > 0 || search || hasActiveFilters ? 'rounded-lg border border-border' : ''}>
						{!ready ? (
							<div className="p-8" />
						) : items.length === 0 ? (
							search || hasActiveFilters ? (
								<div className="p-8 text-center text-text-secondary text-sm">No content matches your filters.</div>
							) : (
								<div className="flex flex-col items-center pt-[15vh] text-center">
									<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
										<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
											<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
											<polyline points="14 2 14 8 20 8" />
											<line x1="16" y1="13" x2="8" y2="13" />
											<line x1="16" y1="17" x2="8" y2="17" />
										</svg>
									</div>
									<h3 className="font-semibold text-text mb-1">No content yet</h3>
									<p className="text-sm text-text-secondary max-w-xs mb-5">
										Create your first {collection.label.toLowerCase()} entry.
									</p>
									<Link
										to="/collections/$slug/$contentId" params={{ slug, contentId: 'new' }}
										className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
									>
										Create {collection.label.replace(/s$/, '')}
									</Link>
								</div>
							)
						) : (
							<table className="w-full text-sm">
								<thead>
									<tr className="text-left text-text-secondary border-b border-border">
										{visibleColumns.map((col) => (
											<th key={col.id} className="px-4 py-3 font-medium">{col.label}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{items.map((item) => (
										<tr key={item.id} className="border-b border-border hover:bg-surface-alt transition-colors">
											{visibleColumns.map((col) => (
												<td key={col.id} className="px-4 py-3">
													{col.render(item, { slug })}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>

					{total > 25 && (
						<div className="flex items-center justify-between mt-4 text-sm text-text-secondary">
							<span>{total} items — page {page}</span>
							<div className="flex gap-2">
								<button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30">Previous</button>
								<button type="button" onClick={() => setPage((p) => p + 1)} disabled={items.length < 25} className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30">Next</button>
							</div>
						</div>
					)}
				</>
			) : !showReviewQueue ? (
				<UpgradePrompt feature="Review Workflows" plan="Pro" />
			) : (
				<div className="rounded-lg border border-border">
					{reviewLoading ? (
						<div className="p-8" />
					) : reviewItems.length === 0 ? (
						<div className="p-8 text-center text-text-secondary text-sm">No content pending review.</div>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-text-secondary border-b border-border">
									<th className="px-4 py-3 font-medium">Title</th>
									<th className="px-4 py-3 font-medium">Slug</th>
									<th className="px-4 py-3 font-medium">Last edited</th>
									<th className="px-4 py-3 font-medium text-right">Actions</th>
								</tr>
							</thead>
							<tbody>
								{reviewItems.map((item) => (
									<tr key={item.id} className="border-b border-border hover:bg-surface-alt transition-colors">
										<td className="px-4 py-3">
											<Link to="/collections/$slug/$contentId" params={{ slug, contentId: item.id }} className="hover:text-text transition-colors">
												{(item.metadata?.title as string) || item.slug}
											</Link>
										</td>
										<td className="px-4 py-3 text-text-secondary font-mono text-xs">{item.slug}</td>
										<td className="px-4 py-3 text-text-secondary" title={absoluteDate(item.updatedAt)}>{relativeTime(item.updatedAt)}</td>
										<td className="px-4 py-3 text-right">
											<div className="flex gap-2 justify-end">
												<button type="button" onClick={() => approveItem(item.id)} className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover">Approve</button>
												<button type="button" onClick={() => rejectItem(item.id)} className="px-3 py-1 bg-btn-secondary text-text-secondary rounded text-xs hover:bg-btn-secondary-hover">Reject</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			)}
		</div>
	)
}
