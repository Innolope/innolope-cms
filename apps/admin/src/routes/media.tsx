import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dropdown } from '../components/dropdown'
import { LicenseGate } from '../components/license-gate'
import { ImageThumb } from '../components/media/image-thumb'
import { UnsplashPicker } from '../components/media/unsplash-picker'
import { ApiError, api } from '../lib/api-client'
import { useAuth } from '../lib/auth'
import { useCollections } from '../lib/collections'
import { useConfirm } from '../lib/confirm'
import {
	canUploadTo,
	fetchMediaAssets,
	listMediaSources,
	type MediaAsset,
	PROJECT_LIBRARY_ID,
	uploadToSource,
} from '../lib/media-sources'

export const Route = createFileRoute('/media')({
	component: MediaLibrary,
})

/**
 * Imported libraries rarely carry a mime-type column, and the ones that do are
 * image libraries anyway — so an unknown type is treated as an image and the
 * `<img>` tag's own error handling covers the rest.
 */
function isImageAsset(asset: MediaAsset): boolean {
	return !asset.mimeType || asset.mimeType.startsWith('image/')
}

// The Media library is a Pro feature. The tab stays visible to free users but
// renders an upgrade prompt instead of the library.
function MediaLibrary() {
	const { t } = useTranslation()
	return (
		<LicenseGate feature="media-integrations" featureLabel={t('mediaRoute.featureLabel')}>
			<MediaLibraryContent />
		</LicenseGate>
	)
}

function MediaLibraryContent() {
	const { t } = useTranslation()
	const [tab, setTabState] = useState<'uploaded' | 'unsplash'>(() => {
		const params = new URLSearchParams(window.location.search)
		return (params.get('tab') as 'uploaded' | 'unsplash') || 'uploaded'
	})
	const setTab = (t: 'uploaded' | 'unsplash') => {
		setTabState(t)
		const url = new URL(window.location.href)
		url.searchParams.set('tab', t)
		window.history.replaceState({}, '', url.toString())
	}
	const [items, setItems] = useState<MediaAsset[]>([])
	const [ready, setReady] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [selected, setSelected] = useState<MediaAsset | null>(null)
	const [typeFilter, setTypeFilter] = useState('')
	const [altDraft, setAltDraft] = useState('')
	const [savingAlt, setSavingAlt] = useState(false)
	const fileRef = useRef<HTMLInputElement>(null)
	const confirm = useConfirm()
	const { collections } = useCollections()
	const { currentProject } = useAuth()

	// Media sources: the project library plus every imported media library. Without
	// this the page showed only the project library while relation pickers offered a
	// completely different set of files — the same asset was reachable from one place
	// and invisible in the other.
	const sources = listMediaSources(collections, t('mediaRoute.sources.library'))
	const [sourceId, setSourceId] = useState<string>(PROJECT_LIBRARY_ID)
	const source = sources.find((s) => s.id === sourceId) ?? sources[0]
	const isImported = !!source?.collection
	const canUpload = canUploadTo(source)

	// Sync the alt-text editor whenever a different media item is opened.
	useEffect(() => {
		setAltDraft(selected?.alt || '')
	}, [selected])

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the source id, not the derived object (whose identity changes every render).
	const fetchMedia = useCallback(() => {
		const active = sources.find((s) => s.id === sourceId) ?? sources[0]
		if (!active) return
		fetchMediaAssets(active, { limit: 50, type: typeFilter || undefined })
			.then(setItems)
			.catch(() => {})
			.finally(() => setReady(true))
	}, [typeFilter, sourceId])

	useEffect(() => {
		fetchMedia()
	}, [fetchMedia])

	// Switching source invalidates the open detail panel.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on sourceId alone.
	useEffect(() => {
		setSelected(null)
	}, [sourceId])

	const upload = async (files: FileList) => {
		if (!source || !currentProject) return
		setUploading(true)
		for (const file of Array.from(files)) {
			try {
				await uploadToSource(source, file, currentProject.id)
			} catch {
				// ignore individual failures
			}
		}
		setUploading(false)
		fetchMedia()
	}

	const deleteMedia = async (id: string) => {
		const ok = await confirm({
			title: t('mediaRoute.delete.title'),
			message: t('mediaRoute.delete.message'),
			confirmLabel: t('mediaRoute.delete.confirm'),
			danger: true,
		})
		if (!ok) return
		try {
			await api.delete(`/api/v1/media/${id}`)
		} catch (err) {
			// 409 = the file is still referenced by content; deleting would break
			// those images. Surface the usage count and require a second, explicit
			// confirmation before forcing.
			if (err instanceof ApiError && err.status === 409) {
				const forced = await confirm({
					title: t('mediaRoute.delete.inUseTitle'),
					message: err.message,
					confirmLabel: t('mediaRoute.delete.inUseConfirm'),
					danger: true,
				})
				if (!forced) return
				await api.delete(`/api/v1/media/${id}?force=true`)
			} else {
				throw err
			}
		}
		setSelected(null)
		fetchMedia()
	}

	const saveAlt = async () => {
		if (!selected) return
		setSavingAlt(true)
		try {
			// Alt text is project-library only (see the guard on the editor below), so the
			// response is a `media` row — merge just the field that changed rather than
			// swapping in a differently-shaped object.
			await api.patch(`/api/v1/media/${selected.id}`, { alt: altDraft })
			const next = { ...selected, alt: altDraft }
			setSelected(next)
			setItems((prev) => prev.map((i) => (i.id === next.id ? next : i)))
		} catch {
			// ignore — surfaced by the disabled state staying actionable
		} finally {
			setSavingAlt(false)
		}
	}

	const formatSize = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}

	return (
		<div className="flex h-full">
			<div className="flex-1 p-8 pt-5 flex flex-col overflow-auto">
				<div className="flex items-center justify-between mb-6">
					<div className="flex items-center gap-4">
						<h2 className="text-2xl font-bold">{t('mediaRoute.title')}</h2>
						<div className="flex bg-surface rounded-lg p-0.5 border border-border">
							<button
								type="button"
								onClick={() => setTab('uploaded')}
								className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${tab === 'uploaded' ? 'bg-surface-alt text-text' : 'text-text-secondary hover:text-text-muted'}`}
							>
								{t('mediaRoute.tabs.uploaded')}
							</button>
							<button
								type="button"
								onClick={() => setTab('unsplash')}
								className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center ${tab === 'unsplash' ? 'bg-surface-alt text-text' : 'text-text-secondary hover:text-text-muted'}`}
							>
								{t('mediaRoute.tabs.unsplash')}
							</button>
						</div>
						{/* Source switcher — only meaningful once an imported media library exists. */}
						{tab === 'uploaded' && sources.length > 1 && (
							<Dropdown
								value={sourceId}
								onChange={setSourceId}
								options={sources.map((s) => ({ value: s.id, label: s.label }))}
								className="w-44"
							/>
						)}
					</div>
					{items.length > 0 && (
						<div className="flex items-center gap-2">
							{/* The type filter is a project-library concept; imported libraries
							    have no `type` column to filter on. */}
							{!isImported && (
								<Dropdown
									value={typeFilter}
									onChange={setTypeFilter}
									options={[
										{ value: '', label: t('mediaRoute.filter.all') },
										{ value: 'image', label: t('mediaRoute.filter.images') },
										{ value: 'video', label: t('mediaRoute.filter.videos') },
										{ value: 'file', label: t('mediaRoute.filter.files') },
									]}
									className="w-32"
								/>
							)}
							{canUpload && (
								<button
									type="button"
									onClick={() => fileRef.current?.click()}
									disabled={uploading}
									className="px-3 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
								>
									{uploading ? t('mediaRoute.uploading') : t('mediaRoute.upload')}
								</button>
							)}
							<input
								ref={fileRef}
								type="file"
								multiple
								className="hidden"
								onChange={(e) => e.target.files && upload(e.target.files)}
							/>
						</div>
					)}
				</div>

				<div className={tab === 'unsplash' ? '' : 'hidden'}>
					<UnsplashPicker onSave={fetchMedia} />
				</div>
				{tab === 'uploaded' && (
					<div className="flex flex-col flex-1">
						{!ready ? (
							<div />
						) : items.length === 0 ? (
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
										<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
										<circle cx="8.5" cy="8.5" r="1.5" />
										<polyline points="21 15 16 10 5 21" />
									</svg>
								</div>
								<h3 className="font-semibold text-text mb-1">{t('mediaRoute.empty.title')}</h3>
								<p className="text-sm text-text-secondary max-w-xs mb-5">
									{t('mediaRoute.empty.subtitle')}
								</p>
								{canUpload && (
									<button
										type="button"
										onClick={() => fileRef.current?.click()}
										className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
									>
										{t('mediaRoute.empty.uploadFirst')}
									</button>
								)}
							</div>
						) : (
							<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
								{items.map((item) => (
									<button
										type="button"
										key={item.id}
										onClick={() => setSelected(item)}
										className={`group relative aspect-square rounded-lg overflow-hidden border transition-colors ${
											selected?.id === item.id
												? 'border-text'
												: 'border-border hover:border-text-muted'
										}`}
									>
										{isImageAsset(item) ? (
											<ImageThumb
												url={item.variants?.small || item.url}
												alt={item.alt || item.filename}
												placeholderLabel={item.filename}
												className="w-full h-full object-cover"
											/>
										) : (
											<div className="flex items-center justify-center h-full bg-surface text-text-secondary text-xs">
												{item.mimeType?.startsWith('video/')
													? t('mediaRoute.types.video')
													: t('mediaRoute.types.file')}
												<br />
												{item.filename}
											</div>
										)}
										<div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1 text-xs text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
											{item.filename}
										</div>
									</button>
								))}
							</div>
						)}

						{/* Drop zone at bottom — hidden for reference-only libraries. */}
						<div className={`mt-auto pt-4 ${canUpload ? '' : 'hidden'}`}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop zone; keyboard users upload via the Choose Files button. */}
							<div
								className="border-2 border-dashed border-border rounded-lg py-16 px-6 text-text-secondary text-sm hover:border-text-muted transition-colors flex items-center justify-center"
								onDragOver={(e) => {
									e.preventDefault()
									e.currentTarget.classList.add('border-text-secondary')
								}}
								onDragLeave={(e) => {
									e.currentTarget.classList.remove('border-text-secondary')
								}}
								onDrop={(e) => {
									e.preventDefault()
									e.currentTarget.classList.remove('border-text-secondary')
									if (e.dataTransfer.files.length) upload(e.dataTransfer.files)
								}}
							>
								{t('mediaRoute.dropHere')}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Detail panel */}
			{selected && (
				<div className="w-72 border-l border-border p-6 space-y-4 overflow-auto">
					<h3 className="font-semibold text-sm">{t('mediaRoute.details.title')}</h3>
					{isImageAsset(selected) && (
						<ImageThumb
							url={selected.variants?.small || selected.url}
							alt={selected.alt || ''}
							placeholderLabel={selected.filename}
							className="w-full aspect-video rounded"
						/>
					)}
					<dl className="text-sm space-y-2">
						<dt className="text-text-secondary">{t('mediaRoute.details.filename')}</dt>
						<dd className="break-all">{selected.filename}</dd>
						{selected.mimeType && (
							<>
								<dt className="text-text-secondary">{t('mediaRoute.details.type')}</dt>
								<dd>{selected.mimeType}</dd>
							</>
						)}
						{selected.size !== undefined && (
							<>
								<dt className="text-text-secondary">{t('mediaRoute.details.size')}</dt>
								<dd>{formatSize(selected.size)}</dd>
							</>
						)}
						<dt className="text-text-secondary">{t('mediaRoute.details.url')}</dt>
						<dd>
							<button
								type="button"
								onClick={() => {
									navigator.clipboard.writeText(selected.url)
								}}
								className="text-xs text-blue-400 hover:text-blue-300"
							>
								{t('mediaRoute.details.copyUrl')}
							</button>
						</dd>
						{selected.createdAt && (
							<>
								<dt className="text-text-secondary">{t('mediaRoute.details.uploaded')}</dt>
								<dd>{new Date(selected.createdAt).toLocaleString()}</dd>
							</>
						)}
					</dl>

					{/* Alt text and delete write through `/api/v1/media`, which only knows the
					    project library. An imported library's rows live in the customer's own
					    database — edit or delete those from the collection itself. */}
					{!isImported && isImageAsset(selected) && (
						<div className="pt-4 border-t border-border space-y-1.5">
							<label htmlFor="media-alt" className="text-text-secondary text-sm">
								{t('mediaRoute.details.altText')}
							</label>
							<textarea
								id="media-alt"
								value={altDraft}
								onChange={(e) => setAltDraft(e.target.value)}
								rows={2}
								placeholder={t('mediaRoute.details.altPlaceholder')}
								className="w-full px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong resize-y"
							/>
							<button
								type="button"
								onClick={saveAlt}
								disabled={savingAlt || altDraft === (selected.alt || '')}
								className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
							>
								{savingAlt ? t('mediaRoute.details.savingAlt') : t('mediaRoute.details.saveAlt')}
							</button>
						</div>
					)}

					<div className="pt-4 border-t border-border flex gap-2">
						{!isImported && (
							<button
								type="button"
								onClick={() => deleteMedia(selected.id)}
								className="px-3 py-1.5 bg-danger-surface text-danger rounded text-sm hover:opacity-80"
							>
								{t('mediaRoute.details.delete')}
							</button>
						)}
						<button
							type="button"
							onClick={() => setSelected(null)}
							className="px-3 py-1.5 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
						>
							{t('mediaRoute.details.close')}
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
