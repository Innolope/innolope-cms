import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import type { CollectionWithCount } from '../../lib/collections'
import { resolveDisplayTitle } from '../../lib/display-title'
import { SyncConflictComparison } from './sync-conflict-comparison'

export interface SyncConflict {
	contentId: string
	externalId: string
	slug: string | null
	metadata: Record<string, unknown>
	token: string
	fullComparison?: boolean
	preview?: boolean
	local?: { metadata: Record<string, unknown>; markdown: string; status: string }
	external?: { metadata: Record<string, unknown>; markdown: string; status: string }
	categories: Array<'content' | 'details' | 'status'>
}
export type SyncResolutions = Record<string, { token: string; choice: 'local' | 'external' }>

export function SyncConflictsDialog({
	conflicts: providedConflicts,
	collection,
	defaultLocale,
	syncing,
	onCancel,
	onConfirm,
}: {
	conflicts: SyncConflict[]
	collection: CollectionWithCount
	defaultLocale: string
	syncing: boolean
	onCancel: () => void
	onConfirm: (resolutions: SyncResolutions) => void
}) {
	const { t } = useTranslation()
	const originKey = `${collection.id}:${providedConflicts.map((item) => `${item.contentId}:${item.token}`).join('|')}`
	const [refreshed, setRefreshed] = useState<{ originKey: string; items: SyncConflict[] } | null>(
		null,
	)
	const conflicts = refreshed?.originKey === originKey ? refreshed.items : providedConflicts
	const origin = useRef(originKey)
	origin.current = originKey
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const [choices, setChoices] = useState<SyncResolutions>({})
	const [loaded, setLoaded] = useState<Record<string, SyncConflict>>({})
	const known = useRef(loaded)
	const [errors, setErrors] = useState<
		Record<string, { token: string; message: string; stale?: boolean }>
	>({})
	const [retry, setRetry] = useState(0)
	const [refreshingFor, setRefreshingFor] = useState<string | null>(null)
	const refreshing = refreshingFor === originKey
	const key = (item: SyncConflict) => `${collection.id}:${item.contentId}`
	const complete = (item: SyncConflict) => !item.preview || loaded[key(item)]?.token === item.token
	const mustRecheck = (item: SyncConflict) =>
		!item.fullComparison || (errors[key(item)]?.token === item.token && errors[key(item)]?.stale)
	useEffect(() => {
		let active = true
		const controller = new AbortController()
		const timer = window.setTimeout(() => {
			controller.abort()
		}, 5000)
		for (const item of conflicts) {
			const id = `${collection.id}:${item.contentId}`
			if (!item.preview || !item.fullComparison || known.current[id]?.token === item.token) continue
			void api
				.get<SyncConflict>(
					`/api/v1/collections/${collection.id}/sync-conflicts/${item.contentId}?token=${encodeURIComponent(item.token)}&attempt=${retry}`,
					{ signal: controller.signal },
				)
				.then((comparison) => {
					if (
						!active ||
						controller.signal.aborted ||
						comparison.token !== item.token ||
						comparison.preview
					)
						return
					known.current = { ...known.current, [id]: comparison }
					setLoaded(known.current)
				})
				.catch((error: unknown) => {
					if (active)
						setErrors((current) => ({
							...current,
							[id]: {
								token: item.token,
								message:
									error instanceof Error
										? error.message
										: t('collections.list.syncDialog.loadFailed'),
								stale:
									typeof error === 'object' &&
									error !== null &&
									'status' in error &&
									error.status === 409,
							},
						}))
				})
		}
		return () => {
			active = false
			window.clearTimeout(timer)
			controller.abort()
		}
	}, [conflicts, collection.id, retry, t])
	const refresh = async () => {
		setRefreshingFor(originKey)
		try {
			const result = await api.post<{ conflicts: SyncConflict[] }>(
				`/api/v1/collections/${collection.id}/sync`,
				{},
			)
			if (!mounted.current || origin.current !== originKey) return
			const openedIds = new Set(conflicts.map((item) => item.contentId))
			const relevant = result.conflicts.filter((item) => openedIds.has(item.contentId))
			if (relevant.length === 0) {
				onCancel()
				return
			}
			for (const item of result.conflicts)
				known.current[`${collection.id}:${item.contentId}`] = item
			setLoaded({ ...known.current })
			setRefreshed({ originKey, items: relevant })
		} catch (error) {
			if (!mounted.current || origin.current !== originKey) return
			setErrors((current) => ({
				...current,
				refresh: {
					token: '',
					message:
						error instanceof Error ? error.message : t('collections.list.syncDialog.loadFailed'),
				},
			}))
		} finally {
			if (mounted.current && origin.current === originKey) setRefreshingFor(null)
		}
	}
	const ready =
		conflicts.length > 0 &&
		conflicts.every((item) => complete(item) && choices[item.contentId]?.token === item.token)
	return (
		<div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-6">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-conflicts-title"
				className="w-full max-w-5xl max-h-[86vh] bg-surface border border-border rounded-lg shadow-xl flex flex-col"
			>
				<div className="p-5 border-b border-border">
					<h3 id="sync-conflicts-title" className="text-lg font-semibold text-text">
						{t('collections.list.syncDialog.title')}
					</h3>
					<p className="mt-2 text-sm text-text-secondary">
						{t('collections.list.syncDialog.intro', { count: conflicts.length })}
					</p>
				</div>
				<div className="overflow-auto p-5 space-y-4">
					{conflicts.map((item) => (
						<fieldset
							key={item.contentId}
							disabled={syncing || refreshing}
							className="border border-border rounded-lg p-4"
						>
							<legend className="px-1 text-sm font-medium text-text">
								{resolveDisplayTitle({ ...item, id: item.contentId }, collection, {
									defaultLocale,
								})}
							</legend>
							<p className="text-sm text-text-secondary mb-3">
								{t('collections.list.syncDialog.recordConflict', {
									areas: item.categories
										.map((area) => t(`collections.list.syncDialog.areas.${area}`))
										.join(', '),
								})}
							</p>
							<div className="grid sm:grid-cols-2 gap-2">
								{(['local', 'external'] as const).map((choice) => (
									<label
										key={choice}
										className="flex gap-2 items-center p-3 rounded border border-border text-sm cursor-pointer hover:bg-surface-alt"
									>
										<input
											type="radio"
											name={`sync-${item.contentId}`}
											value={choice}
											aria-label={t(`collections.list.syncDialog.${choice}`)}
											disabled={!complete(item)}
											checked={
												choices[item.contentId]?.token === item.token &&
												choices[item.contentId]?.choice === choice
											}
											onChange={() =>
												setChoices((current) => ({
													...current,
													[item.contentId]: { token: item.token, choice },
												}))
											}
										/>
										<span className="min-w-0">
											<span className="block font-medium">
												{t(`collections.list.syncDialog.${choice}`)}
											</span>
										</span>
									</label>
								))}
							</div>
							{complete(item) ? (
								<SyncConflictComparison
									key={item.token}
									item={loaded[key(item)]?.token === item.token ? loaded[key(item)] : item}
									collection={collection}
								/>
							) : (
								<div className="mt-4 text-sm text-text-secondary" role="status">
									<p>
										{errors[key(item)]?.token === item.token
											? errors[key(item)].message
											: t(
													item.fullComparison
														? 'collections.list.syncDialog.loading'
														: 'collections.list.syncDialog.legacyPreview',
												)}
									</p>
									<button
										type="button"
										className="mt-2 underline"
										disabled={syncing || refreshing}
										onClick={() => (mustRecheck(item) ? void refresh() : setRetry(retry + 1))}
									>
										{t(
											!mustRecheck(item)
												? 'collections.list.syncDialog.retry'
												: 'collections.list.syncDialog.refresh',
										)}
									</button>
								</div>
							)}
						</fieldset>
					))}
				</div>
				<div className="p-4 border-t border-border flex items-center justify-end gap-2">
					{errors.refresh && (
						<p role="alert" className="mr-auto text-sm text-red-600">
							{errors.refresh.message}
						</p>
					)}
					<button
						type="button"
						onClick={onCancel}
						disabled={syncing}
						className="px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover disabled:opacity-50"
					>
						{t('collections.list.syncDialog.later')}
					</button>
					<button
						type="button"
						onClick={() => {
							if (ready && !syncing && !refreshing)
								onConfirm(
									Object.fromEntries(
										conflicts.map((item) => [item.contentId, choices[item.contentId]]),
									),
								)
						}}
						disabled={syncing || refreshing || !ready}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{t(syncing ? 'collections.list.sync.syncing' : 'collections.list.syncDialog.apply')}
					</button>
				</div>
			</div>
		</div>
	)
}
