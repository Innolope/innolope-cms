import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router'
import {
	type ChangeEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ColumnConfig, type ColumnOption } from '../components/column-config'
import { FilterBar, type FilterDescriptor } from '../components/filter-bar'
import { hasFeature, ProBadge, UpgradePrompt, useLicense } from '../components/license-gate'
import { api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { type CollectionWithCount, useCollections } from '../lib/collections'
import { usePrompt } from '../lib/confirm'
import { pickTitleField, resolveDisplayTitle } from '../lib/display-title'
import { isLocaleMap, resolveLocalizedValue } from '../lib/locale-value'
import { absoluteDate, relativeTime } from '../lib/relative-time'
import { useToast } from '../lib/toast'
import { useColumnConfig } from '../lib/use-column-config'
import { type FilterMap, useUrlFilters } from '../lib/use-url-filters'
import { useUrlSort } from '../lib/use-url-sort'

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
	externalId?: string | null
	createdAt: string | null
	updatedAt: string | null
	publishedAt?: string | null
}

interface ContentResponse {
	data: ContentItem[]
	pagination: { page: number; limit: number; total: number; totalPages: number }
	live?: boolean
}

interface ImportStatus {
	status: 'pending' | 'running' | 'completed' | 'failed'
	processed: number
	total: number | null
	error: string | null
}

interface SyncPreviewItem {
	externalId: string
	contentId?: string
	slug: string
	changeType: 'created' | 'updated'
	changes: Array<{ field: string; local: unknown; external: unknown }>
}

interface SyncPreview {
	discrepancies: SyncPreviewItem[]
	total: number
}

const STATUS_STYLES: Record<string, string> = {
	draft: 'bg-surface-alt text-text-secondary',
	pending_review: 'bg-surface-alt text-text',
	published: 'bg-surface-alt text-text',
	archived: 'bg-surface-alt text-text-muted',
}

const STATUS_KEYS: Record<string, string> = {
	draft: 'collections.list.status.draft',
	pending_review: 'collections.list.status.pendingReview',
	published: 'collections.list.status.published',
	archived: 'collections.list.status.archived',
}

const STATUS_OPTION_KEYS: Record<string, string> = {
	draft: 'collections.list.statusOptions.draft',
	pending_review: 'collections.list.statusOptions.pendingReview',
	published: 'collections.list.statusOptions.published',
	archived: 'collections.list.statusOptions.archived',
}

interface ColumnRenderCtx {
	slug: string
	defaultLocale: string
	locales: string[]
}

interface ColumnDescriptor {
	id: string
	label: string
	render: (item: ContentItem, ctx: ColumnRenderCtx) => ReactNode
	/** Whether this column can be sorted server-side. */
	sortable: boolean
	/** Backend `sortBy` value sent when this column is the active sort. */
	sortKey?: string
}

// Field types whose values are scalar enough to order meaningfully. Mirrors the
// server-side whitelist in apps/api/src/routes/v1/content.ts.
const SORTABLE_FIELD_TYPES = new Set(['text', 'string', 'number', 'boolean', 'date', 'enum'])

type Translator = (key: string, opts?: Record<string, unknown>) => string

function buildColumns(collection: CollectionWithCount, t: Translator): ColumnDescriptor[] {
	const fields = collection.fields || []
	// Whichever field acts as the row label — either the user-pinned `titleField`
	// on the collection, or the heuristic pick over the schema. We exclude this
	// field from the metadata columns below so it isn't rendered twice.
	const primaryField = pickTitleField(collection)
	const primaryLabel =
		primaryField === 'name'
			? t('collections.list.columns.name')
			: t('collections.list.columns.title')

	// The title cell renders `metadata[primaryField]` (or slug when no title field
	// exists), so sorting it maps to that underlying key. A non-scalar title field
	// (e.g. a localized object) isn't orderable.
	const primaryFieldDef = primaryField ? fields.find((f) => f.name === primaryField) : undefined
	const titleSortKey = primaryField
		? primaryFieldDef && SORTABLE_FIELD_TYPES.has(primaryFieldDef.type)
			? `meta:${primaryField}`
			: undefined
		: 'slug'

	const builtins: ColumnDescriptor[] = [
		{
			id: 'title',
			label: primaryLabel,
			sortable: Boolean(titleSortKey),
			sortKey: titleSortKey,
			render: (item, ctx) => {
				const label = resolveDisplayTitle(item, collection, {
					defaultLocale: ctx.defaultLocale,
				})
				return (
					<Link
						to="/collections/$slug/$contentId"
						params={{ slug: ctx.slug, contentId: item.id }}
						className="hover:text-text transition-colors"
					>
						{label}
					</Link>
				)
			},
		},
		{
			id: 'slug',
			label: t('collections.list.columns.slug'),
			sortable: true,
			sortKey: 'slug',
			render: (item) => <span className="text-text-secondary font-mono text-xs">{item.slug}</span>,
		},
		{
			id: 'status',
			label: t('collections.list.columns.status'),
			sortable: true,
			sortKey: 'status',
			render: (item) => (
				<span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLES[item.status] || ''}`}>
					{STATUS_KEYS[item.status] ? t(STATUS_KEYS[item.status]) : item.status}
				</span>
			),
		},
		{
			id: 'locale',
			label: t('collections.list.columns.locale'),
			sortable: true,
			sortKey: 'locale',
			render: (item) => <span className="text-text-secondary text-xs">{item.locale}</span>,
		},
		{
			id: 'updatedAt',
			label: t('collections.list.columns.lastEdited'),
			sortable: true,
			sortKey: 'updatedAt',
			render: (item) => {
				if (!item.updatedAt) return <span className="text-text-muted">—</span>
				const created = item.createdAt ? new Date(item.createdAt).getTime() : Number.NaN
				const updated = new Date(item.updatedAt).getTime()
				const neverEdited = Number.isFinite(created) && Math.abs(updated - created) < 5_000
				return (
					<span
						className={neverEdited ? 'text-text-muted italic' : 'text-text-secondary'}
						title={
							neverEdited
								? t('collections.list.importedNeverEdited', { date: absoluteDate(item.updatedAt) })
								: absoluteDate(item.updatedAt)
						}
					>
						{relativeTime(item.updatedAt)}
					</span>
				)
			},
		},
		{
			id: 'createdAt',
			label: t('collections.list.columns.created'),
			sortable: true,
			sortKey: 'createdAt',
			render: (item) =>
				item.createdAt ? (
					<span className="text-text-secondary" title={absoluteDate(item.createdAt)}>
						{relativeTime(item.createdAt)}
					</span>
				) : (
					<span className="text-text-muted">—</span>
				),
		},
		{
			id: 'publishedAt',
			label: t('collections.list.columns.published'),
			sortable: true,
			sortKey: 'publishedAt',
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

	const metadataCols: ColumnDescriptor[] = fields
		.filter((f) => f.name !== primaryField)
		.map((f) => ({
			id: `meta:${f.name}`,
			label: f.name,
			sortable: SORTABLE_FIELD_TYPES.has(f.type),
			sortKey: SORTABLE_FIELD_TYPES.has(f.type) ? `meta:${f.name}` : undefined,
			render: (item, ctx) => renderMetadataValue(item.metadata?.[f.name], ctx),
		}))

	return [...builtins, ...metadataCols]
}

/** Pull a usable image URL out of a resolved relation/media record, if present. */
function extractImageUrl(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	if (typeof v.url === 'string') return v.url
	const meta = v.metadata as Record<string, unknown> | undefined
	if (meta && typeof meta.url === 'string') return meta.url
	return null
}

function renderMetadataValue(value: unknown, ctx?: ColumnRenderCtx): ReactNode {
	if (value === null || value === undefined || value === '')
		return <span className="text-text-muted">—</span>
	if (typeof value === 'boolean')
		return <span className="text-text-secondary">{value ? '✓' : '—'}</span>
	if (Array.isArray(value))
		return <span className="text-text-secondary text-xs">{value.join(', ')}</span>
	if (typeof value === 'object') {
		const imgUrl = extractImageUrl(value)
		if (imgUrl)
			return (
				<img src={imgUrl} alt="" className="h-8 w-8 rounded object-cover border border-border" />
			)
		// Localized `{ locale: text }` map — show the interface-language value.
		if (ctx && isLocaleMap(value, ctx.locales)) {
			const resolved = resolveLocalizedValue(value, { defaultLocale: ctx.defaultLocale })
			if (resolved) return <span className="text-text-secondary">{resolved}</span>
		}
		return <span className="text-text-muted text-xs italic">[object]</span>
	}
	return <span className="text-text-secondary">{String(value)}</span>
}

function buildFilters(collection: CollectionWithCount, t: Translator): FilterDescriptor[] {
	const statusOptions = Object.keys(STATUS_OPTION_KEYS).map((value) => ({
		value,
		label: t(STATUS_OPTION_KEYS[value]),
	}))
	const builtins: FilterDescriptor[] = [
		{
			id: 'status',
			label: t('collections.list.columns.status'),
			type: 'enum',
			options: statusOptions,
		},
		{ id: 'locale', label: t('collections.list.columns.locale'), type: 'text' },
		{ id: 'updatedAt', label: t('collections.list.columns.lastEdited'), type: 'date-range' },
		{ id: 'createdAt', label: t('collections.list.columns.created'), type: 'date-range' },
		{ id: 'publishedAt', label: t('collections.list.columns.published'), type: 'date-range' },
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
	const { t } = useTranslation()
	const { slug } = Route.useParams()
	const { getCollectionByName } = useCollections()
	const collection = getCollectionByName(slug)
	const toast = useToast()
	const prompt = usePrompt()
	const license = useLicense()
	const { currentProject } = useAuth()
	const showReviewQueue = hasFeature(license, 'review-workflows')
	const [uploading, setUploading] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)

	// An imported media collection backed by writable external storage can receive uploads.
	const mediaUpload = useMemo(() => {
		if (!collection || collection.source !== 'external' || collection.accessMode !== 'read-write') {
			return null
		}
		const externalDb = (currentProject?.settings as Record<string, unknown> | undefined)
			?.externalDb as Record<string, unknown> | undefined
		const map = externalDb?.mediaStorage as
			| Record<string, { adapter?: string; hasCredentials?: boolean }>
			| undefined
		const entry = map?.[collection.name]
		if (!entry || (entry.adapter !== 'r2' && entry.adapter !== 'cloudflare-images')) return null
		if (!entry.hasCredentials) return null
		return entry
	}, [collection, currentProject])

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
	const [isLive, setIsLive] = useState(false)
	const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(1)
	const [ready, setReady] = useState(false)
	const [search, setSearch] = useState('')
	const [syncing, setSyncing] = useState(false)
	const [syncPreview, setSyncPreview] = useState<SyncPreview | null>(null)
	const [previewLoading, setPreviewLoading] = useState(false)

	const { filters, setFilter, clearAll } = useUrlFilters()
	const { sort, toggleSort } = useUrlSort()

	// Sorting changes which rows fall on the first page, so reset pagination too.
	const handleSort = useCallback(
		(key: string) => {
			toggleSort(key)
			setPage(1)
		},
		[toggleSort],
	)

	const allColumns: ColumnDescriptor[] = useMemo(
		() => (collection ? buildColumns(collection, t) : []),
		[collection, t],
	)
	const allFilters: FilterDescriptor[] = useMemo(
		() => (collection ? buildFilters(collection, t) : []),
		[collection, t],
	)

	// Built-in columns with no real data for this collection — an id-derived slug, or
	// timestamps that were never set — are dropped so they don't show a meaningless
	// value or clutter the column picker.
	const suppressedColumns = useMemo(() => {
		const set = new Set<string>()
		if (items.length === 0) return set
		const isSyntheticSlug = (it: ContentItem) => {
			const extId = (it.externalId || it.id || '').toLowerCase()
			if (!extId) return false
			const s = (it.slug || '').toLowerCase()
			return s === extId || s === `${extId}-${extId.slice(-6)}`
		}
		if (items.every(isSyntheticSlug)) set.add('slug')
		for (const col of ['updatedAt', 'createdAt', 'publishedAt'] as const) {
			if (items.every((it) => !it[col])) set.add(col)
		}
		return set
	}, [items])

	const availableColumns: ColumnDescriptor[] = useMemo(
		() => allColumns.filter((c) => !suppressedColumns.has(c.id)),
		[allColumns, suppressedColumns],
	)
	const availableColumnIds = useMemo(() => availableColumns.map((c) => c.id), [availableColumns])

	const columnConfig = useColumnConfig({
		collectionId: collection?.id || '__none__',
		available: availableColumnIds,
		defaults: DEFAULT_COLUMNS,
		pinned: PINNED_COLUMNS,
	})

	const visibleColumns: ColumnDescriptor[] = useMemo(
		() =>
			columnConfig.visible
				.map((id) => availableColumns.find((c) => c.id === id))
				.filter((c): c is ColumnDescriptor => Boolean(c)),
		[columnConfig.visible, availableColumns],
	)

	const columnOptions: ColumnOption[] = useMemo(
		() => availableColumns.map((c) => ({ id: c.id, label: c.label })),
		[availableColumns],
	)

	const renderCtx: ColumnRenderCtx = useMemo(() => {
		const s = (currentProject?.settings as Record<string, unknown> | undefined) ?? {}
		const locales =
			Array.isArray(s.locales) && s.locales.length > 0 ? (s.locales as string[]) : ['en']
		const defaultLocale = (s.defaultLocale as string) || locales[0] || 'en'
		return { slug, defaultLocale, locales }
	}, [slug, currentProject])

	const [reviewItems, setReviewItems] = useState<ContentItem[]>([])
	const [reviewTotal, setReviewTotal] = useState(0)
	const [reviewPage, _setReviewPage] = useState(1)
	const [reviewLoading, setReviewLoading] = useState(false)

	const filterQuery = useMemo(() => filtersToQueryParams(filters).toString(), [filters])
	const hasActiveFilters = Object.keys(filters).length > 0

	const fetchContent = useCallback(() => {
		if (!collection) return
		const params = new URLSearchParams()
		params.set('page', String(page))
		params.set('limit', '25')
		params.set('collectionId', collection.id)
		params.set('sortBy', sort.key)
		params.set('sortOrder', sort.dir)
		if (search) params.set('search', search)
		// Merge active filters
		for (const [k, v] of new URLSearchParams(filterQuery)) params.set(k, v)

		api
			.get<ContentResponse>(`/api/v1/content?${params}`)
			.then((res) => {
				setItems(res.data)
				setTotal(res.pagination.total)
				setIsLive(Boolean(res.live))
			})
			.catch(() => {})
			.finally(() => setReady(true))
	}, [page, search, filterQuery, collection, sort])

	useEffect(() => {
		fetchContent()
	}, [fetchContent])

	// Poll the background-import status while a job is in progress.
	useEffect(() => {
		if (!collection || collection.source !== 'external') {
			setImportStatus(null)
			return
		}
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const poll = () => {
			api
				.get<ImportStatus | null>(`/api/v1/collections/${collection.id}/import-status`)
				.then((status) => {
					if (cancelled) return
					setImportStatus(status)
					if (status?.status === 'pending' || status?.status === 'running') {
						timer = setTimeout(poll, 2500)
					}
				})
				.catch(() => {})
		}
		poll()
		return () => {
			cancelled = true
			if (timer) clearTimeout(timer)
		}
	}, [collection])

	// When the import finishes, refresh the list so it serves from the cache.
	const prevImportStatus = useRef<string | undefined>(undefined)
	useEffect(() => {
		const current = importStatus?.status
		if (
			prevImportStatus.current &&
			prevImportStatus.current !== current &&
			(current === 'completed' || current === 'failed')
		) {
			fetchContent()
		}
		prevImportStatus.current = current
	}, [importStatus, fetchContent])

	const fetchReviewQueue = useCallback(() => {
		if (!collection) return
		setReviewLoading(true)
		api
			.get<{ data: ContentItem[]; pagination: { total: number } }>(
				`/api/v1/content/review-queue?page=${reviewPage}&limit=25&collectionId=${collection.id}`,
			)
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
		const reason = await prompt({
			title: t('collections.list.reject.title'),
			message: t('collections.list.reject.message'),
			label: t('collections.list.reject.reasonLabel'),
			placeholder: t('collections.list.reject.reasonPlaceholder'),
			multiline: true,
			confirmLabel: t('collections.list.reject.confirm'),
		})
		if (reason === null) return
		await api.post(`/api/v1/content/${id}/reject`, { reason: reason || undefined })
		fetchReviewQueue()
	}

	const previewExternalSync = async () => {
		if (!collection || collection.source !== 'external') return
		setPreviewLoading(true)
		try {
			const preview = await api.get<SyncPreview>(
				`/api/v1/collections/${collection.id}/sync-preview`,
			)
			if (preview.total === 0) {
				toast(t('collections.list.sync.noDiscrepancies'), 'success')
			} else {
				setSyncPreview(preview)
			}
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.list.sync.previewFailed'), 'error')
		} finally {
			setPreviewLoading(false)
		}
	}

	const syncExternalContent = async () => {
		if (!collection || collection.source !== 'external') return
		setSyncing(true)
		try {
			const result = await api.post<{ created: number; updated: number }>(
				`/api/v1/collections/${collection.id}/sync`,
				{},
			)
			toast(
				t('collections.list.sync.success', { updated: result.updated, count: result.created }),
				'success',
			)
			setSyncPreview(null)
			fetchContent()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.list.sync.failed'), 'error')
		} finally {
			setSyncing(false)
		}
	}

	if (!collection) {
		return (
			<div className="p-8 pt-5">
				<p className="text-text-secondary text-sm">{t('collections.list.notFound')}</p>
			</div>
		)
	}

	const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files
		if (!files || files.length === 0 || !collection || !currentProject) return
		setUploading(true)
		let ok = 0
		try {
			for (const file of Array.from(files)) {
				const form = new FormData()
				form.append('file', file)
				await api.upload(
					`/api/v1/projects/${currentProject.id}/database/media-upload?collectionId=${collection.id}`,
					form,
				)
				ok++
			}
			toast(t('collections.list.uploaded', { count: ok }), 'success')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.list.uploadFailed'), 'error')
		} finally {
			if (ok > 0) fetchContent()
			setUploading(false)
			e.target.value = ''
		}
	}

	const showToolbar = total > 0 || search || hasActiveFilters
	const importActive = importStatus?.status === 'pending' || importStatus?.status === 'running'

	return (
		<div className="p-8 pt-5 flex flex-col min-h-full">
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-4">
					<h2 className="text-2xl font-bold">{collection.label}</h2>
					<div className="flex bg-surface rounded-lg p-0.5 border border-border">
						<button
							type="button"
							onClick={() => setTab('all')}
							className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
								tab === 'all'
									? 'bg-surface-alt text-text'
									: 'text-text-secondary hover:text-text-muted'
							}`}
						>
							{t('collections.list.tabs.all')}
						</button>
						<button
							type="button"
							onClick={() => setTab('review')}
							className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center ${
								tab === 'review'
									? 'bg-surface-alt text-text'
									: 'text-text-secondary hover:text-text-muted'
							}`}
						>
							{t('collections.list.tabs.review')}
							{showReviewQueue && reviewTotal > 0 && (
								<span className="ml-1.5 px-1.5 py-0.5 bg-border rounded-full text-[10px]">
									{reviewTotal}
								</span>
							)}
							{!showReviewQueue && <ProBadge />}
						</button>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{collection.source === 'external' && (
						<button
							type="button"
							onClick={previewExternalSync}
							disabled={previewLoading || syncing}
							className="px-3 py-2 bg-btn-secondary text-text-secondary rounded-md text-sm font-medium hover:bg-btn-secondary-hover hover:text-text transition-colors disabled:opacity-50"
						>
							{previewLoading
								? t('collections.list.sync.checking')
								: syncing
									? t('collections.list.sync.syncing')
									: t('collections.list.sync.button')}
						</button>
					)}
					{mediaUpload && (
						<>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								accept={mediaUpload.adapter === 'cloudflare-images' ? 'image/*' : undefined}
								onChange={handleUpload}
								className="hidden"
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={uploading}
								className="px-3 py-2 bg-btn-secondary text-text-secondary rounded-md text-sm font-medium hover:bg-btn-secondary-hover hover:text-text transition-colors disabled:opacity-50"
							>
								{uploading ? t('collections.list.uploading') : t('collections.list.upload')}
							</button>
						</>
					)}
					<Link
						to="/collections/$slug/edit"
						params={{ slug }}
						className="px-3 py-2 bg-btn-secondary text-text-secondary rounded-md text-sm font-medium hover:bg-btn-secondary-hover hover:text-text transition-colors"
					>
						{t('collections.list.schema')}
					</Link>
					{showToolbar && (
						<Link
							to="/collections/$slug/$contentId"
							params={{ slug, contentId: 'new' }}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover active:translate-x-px active:translate-y-px transition-colors"
						>
							{t('collections.list.newRecord', { name: collection.label.replace(/s$/, '') })}
						</Link>
					)}
				</div>
			</div>

			{tab === 'all' ? (
				<>
					{importActive && (
						<div className="flex items-start gap-2 px-4 py-2.5 mb-4 rounded-lg bg-surface-alt border border-border text-xs text-text-secondary">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="mt-0.5 shrink-0 text-text-muted animate-spin"
							>
								<path d="M21 12a9 9 0 1 1-6.219-8.56" />
							</svg>
							<span>
								{importStatus?.total != null
									? t('collections.list.import.progress', {
											processed: importStatus.processed,
											total: importStatus.total,
										})
									: t('collections.list.import.progressUnknownTotal', {
											processed: importStatus?.processed ?? 0,
										})}
							</span>
						</div>
					)}
					{importStatus?.status === 'failed' && (
						<div className="flex items-start gap-2 px-4 py-2.5 mb-4 rounded-lg bg-surface-alt border border-border text-xs text-text-secondary">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="mt-0.5 shrink-0 text-text-muted"
							>
								<path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
							</svg>
							<span>
								{importStatus.error
									? t('collections.list.import.failedWithError', {
											error: importStatus.error,
										})
									: t('collections.list.import.failed')}
							</span>
						</div>
					)}
					{isLive && !importActive && (
						<div className="flex items-start gap-2 px-4 py-2.5 mb-4 rounded-lg bg-surface-alt border border-border text-xs text-text-secondary">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="mt-0.5 shrink-0 text-text-muted"
							>
								<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
							</svg>
							<span>{t('collections.list.liveDataNote')}</span>
						</div>
					)}
					{showToolbar && (
						<div className="flex flex-col gap-3 mb-4">
							<div className="flex gap-3 items-center">
								<input
									type="text"
									placeholder={t('collections.list.searchPlaceholder')}
									value={search}
									onChange={(e) => {
										setSearch(e.target.value)
										setPage(1)
									}}
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
								onChange={(id, value) => {
									setFilter(id, value)
									setPage(1)
								}}
								onClearAll={() => {
									clearAll()
									setPage(1)
								}}
							/>
						</div>
					)}

					<div
						className={
							total > 0 || search || hasActiveFilters ? 'rounded-lg border border-border' : ''
						}
					>
						{!ready ? (
							<div className="p-8" />
						) : items.length === 0 ? (
							search || hasActiveFilters ? (
								<div className="p-8 text-center text-text-secondary text-sm">
									{t('collections.list.noMatches')}
								</div>
							) : (
								<div className="flex flex-col items-center pt-[15vh] text-center">
									<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
										<svg
											width="28"
											height="28"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.5"
											strokeLinecap="round"
											strokeLinejoin="round"
											className="text-text-muted"
										>
											<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
											<polyline points="14 2 14 8 20 8" />
											<line x1="16" y1="13" x2="8" y2="13" />
											<line x1="16" y1="17" x2="8" y2="17" />
										</svg>
									</div>
									<h3 className="font-semibold text-text mb-1">
										{t('collections.list.empty.title')}
									</h3>
									<p className="text-sm text-text-secondary max-w-xs mb-5">
										{t('collections.list.empty.subtitle', {
											name: collection.label.toLowerCase(),
										})}
									</p>
									<Link
										to="/collections/$slug/$contentId"
										params={{ slug, contentId: 'new' }}
										className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
									>
										{t('collections.list.empty.create', {
											name: collection.label.replace(/s$/, ''),
										})}
									</Link>
								</div>
							)
						) : (
							<table className="w-full text-sm">
								<thead>
									<tr className="text-left text-text-secondary border-b border-border">
										{visibleColumns.map((col) => {
											const sortKey = col.sortable ? col.sortKey : undefined
											const active = sortKey != null && sort.key === sortKey
											return (
												<th
													key={col.id}
													className="px-4 py-3 font-medium"
													aria-sort={
														active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
													}
												>
													{sortKey ? (
														<button
															type="button"
															onClick={() => handleSort(sortKey)}
															className="group inline-flex items-center gap-1 hover:text-text transition-colors"
														>
															{col.label}
															<span
																className={
																	active
																		? 'text-text'
																		: 'text-text-muted opacity-0 transition-opacity group-hover:opacity-100'
																}
															>
																{active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
															</span>
														</button>
													) : (
														col.label
													)}
												</th>
											)
										})}
									</tr>
								</thead>
								<tbody>
									{items.map((item) => (
										<tr
											key={item.id}
											className="border-b border-border hover:bg-surface-alt transition-colors"
										>
											{visibleColumns.map((col) => (
												<td key={col.id} className="px-4 py-3">
													{col.render(item, renderCtx)}
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
							<span>{t('collections.list.pagination.summary', { total, page })}</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => setPage((p) => Math.max(1, p - 1))}
									disabled={page === 1}
									className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30"
								>
									{t('collections.list.pagination.previous')}
								</button>
								<button
									type="button"
									onClick={() => setPage((p) => p + 1)}
									disabled={items.length < 25}
									className="px-3 py-1 bg-btn-secondary rounded disabled:opacity-30"
								>
									{t('collections.list.pagination.next')}
								</button>
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
						<div className="p-8 text-center text-text-secondary text-sm">
							{t('collections.list.review.empty')}
						</div>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-text-secondary border-b border-border">
									<th className="px-4 py-3 font-medium">{t('collections.list.columns.title')}</th>
									<th className="px-4 py-3 font-medium">{t('collections.list.columns.slug')}</th>
									<th className="px-4 py-3 font-medium">
										{t('collections.list.columns.lastEdited')}
									</th>
									<th className="px-4 py-3 font-medium text-right">
										{t('collections.list.columns.actions')}
									</th>
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
												to="/collections/$slug/$contentId"
												params={{ slug, contentId: item.id }}
												className="hover:text-text transition-colors"
											>
												{(item.metadata?.title as string) || item.slug}
											</Link>
										</td>
										<td className="px-4 py-3 text-text-secondary font-mono text-xs">{item.slug}</td>
										<td
											className="px-4 py-3 text-text-secondary"
											title={item.updatedAt ? absoluteDate(item.updatedAt) : undefined}
										>
											{item.updatedAt ? relativeTime(item.updatedAt) : '—'}
										</td>
										<td className="px-4 py-3 text-right">
											<div className="flex gap-2 justify-end">
												<button
													type="button"
													onClick={() => approveItem(item.id)}
													className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover"
												>
													{t('collections.list.review.approve')}
												</button>
												<button
													type="button"
													onClick={() => rejectItem(item.id)}
													className="px-3 py-1 bg-btn-secondary text-text-secondary rounded text-xs hover:bg-btn-secondary-hover"
												>
													{t('collections.list.review.reject')}
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			)}
			{syncPreview && (
				<SyncPreviewDialog
					preview={syncPreview}
					syncing={syncing}
					onCancel={() => setSyncPreview(null)}
					onConfirm={syncExternalContent}
				/>
			)}
		</div>
	)
}

function SyncPreviewDialog({
	preview,
	syncing,
	onCancel,
	onConfirm,
}: {
	preview: SyncPreview
	syncing: boolean
	onCancel: () => void
	onConfirm: () => void
}) {
	const { t } = useTranslation()
	return (
		<div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-6">
			<div className="w-full max-w-4xl max-h-[82vh] bg-surface border border-border rounded-lg shadow-xl flex flex-col">
				<div className="p-5 border-b border-border">
					<h3 className="text-lg font-semibold text-text">
						{t('collections.list.syncDialog.title')}
					</h3>
					<p className="mt-1 text-sm text-text-secondary">
						{t('collections.list.syncDialog.intro')}
					</p>
				</div>
				<div className="overflow-auto p-5 space-y-4">
					{preview.discrepancies.map((item) => (
						<div key={item.externalId} className="border border-border rounded-lg overflow-hidden">
							<div className="px-4 py-3 bg-surface-alt flex items-center justify-between gap-3">
								<div>
									<p className="text-sm font-medium text-text">{item.slug}</p>
									<p className="text-xs text-text-muted font-mono">{item.externalId}</p>
								</div>
								<span className="text-xs text-text-secondary">{item.changeType}</span>
							</div>
							<div className="divide-y divide-border">
								{item.changes.slice(0, 6).map((change) => (
									<div
										key={change.field}
										className="grid grid-cols-[160px_1fr_1fr] gap-3 p-3 text-xs"
									>
										<div className="font-mono text-text-secondary">{change.field}</div>
										<DiffValue
											label={t('collections.list.syncDialog.local')}
											value={change.local}
										/>
										<DiffValue
											label={t('collections.list.syncDialog.external')}
											value={change.external}
										/>
									</div>
								))}
								{item.changes.length > 6 && (
									<div className="px-3 py-2 text-xs text-text-muted">
										{t('collections.list.syncDialog.moreFields', {
											count: item.changes.length - 6,
										})}
									</div>
								)}
							</div>
						</div>
					))}
					{preview.total > preview.discrepancies.length && (
						<p className="text-xs text-text-muted">
							{t('collections.list.syncDialog.showingOf', {
								showing: preview.discrepancies.length,
								total: preview.total,
								count: preview.total,
							})}
						</p>
					)}
				</div>
				<div className="p-4 border-t border-border flex items-center justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						disabled={syncing}
						className="px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover disabled:opacity-50"
					>
						{t('common.cancel')}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={syncing}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{syncing
							? t('collections.list.sync.syncing')
							: t('collections.list.syncDialog.overwrite')}
					</button>
				</div>
			</div>
		</div>
	)
}

function DiffValue({ label, value }: { label: string; value: unknown }) {
	return (
		<div>
			<p className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">{label}</p>
			<pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-input border border-border px-2 py-1.5 text-text-secondary">
				{formatDiffValue(value)}
			</pre>
		</div>
	)
}

function formatDiffValue(value: unknown): string {
	if (value === null || value === undefined || value === '') return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}
