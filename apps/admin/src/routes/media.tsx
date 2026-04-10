import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api-client'
import { UnsplashPicker } from '../components/media/unsplash-picker'
import { useLicense, hasFeature, ProBadge, UpgradePrompt } from '../components/license-gate'
import { Dropdown } from '../components/dropdown'

export const Route = createFileRoute('/media')({
	component: MediaLibrary,
})

interface MediaItem {
	id: string
	type: 'image' | 'video' | 'file'
	filename: string
	mimeType: string
	size: number
	url: string
	alt: string | null
	createdAt: string
}

function MediaLibrary() {
	const license = useLicense()
	const unsplashLicensed = hasFeature(license, 'media-integrations')
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
	const [items, setItems] = useState<MediaItem[]>([])
	const [ready, setReady] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [selected, setSelected] = useState<MediaItem | null>(null)
	const [typeFilter, setTypeFilter] = useState('')
	const fileRef = useRef<HTMLInputElement>(null)

	const fetchMedia = () => {
		const params = new URLSearchParams()
		params.set('limit', '50')
		if (typeFilter) params.set('type', typeFilter)

		api.get<{ data: MediaItem[] }>(`/api/v1/media?${params}`)
			.then((res) => setItems(res.data))
			.catch(() => {})
			.finally(() => setReady(true))
	}

	useEffect(() => {
		fetchMedia()
	}, [typeFilter])

	const upload = async (files: FileList) => {
		setUploading(true)
		for (const file of Array.from(files)) {
			const form = new FormData()
			form.append('file', file)
			try {
				await api.upload('/api/v1/media/upload', form)
			} catch {
				// ignore individual failures
			}
		}
		setUploading(false)
		fetchMedia()
	}

	const deleteMedia = async (id: string) => {
		if (!confirm('Delete this file permanently?')) return
		await api.delete(`/api/v1/media/${id}`)
		setSelected(null)
		fetchMedia()
	}

	const formatSize = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}

	return (
		<div className="flex h-full">
			<div className="flex-1 overflow-auto p-8 pt-5 flex flex-col">
				<div className="flex items-center justify-between mb-6">
					<div className="flex items-center gap-4">
						<h2 className="text-2xl font-bold">Media</h2>
						<div className="flex bg-surface rounded-lg p-0.5 border border-border">
							<button
								type="button"
								onClick={() => setTab('uploaded')}
								className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${tab === 'uploaded' ? 'bg-surface-alt text-text' : 'text-text-secondary hover:text-text-muted'}`}
							>
								Uploaded
							</button>
							<button
								type="button"
								onClick={() => setTab('unsplash')}
								className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center ${tab === 'unsplash' ? 'bg-surface-alt text-text' : 'text-text-secondary hover:text-text-muted'}`}
							>
								Unsplash
								{!unsplashLicensed && <ProBadge />}
							</button>
						</div>
					</div>
					{items.length > 0 && (
						<div className="flex gap-3">
							<Dropdown
								value={typeFilter}
								onChange={setTypeFilter}
								options={[
									{ value: '', label: 'All types' },
									{ value: 'image', label: 'Images' },
									{ value: 'video', label: 'Videos' },
									{ value: 'file', label: 'Files' },
								]}
								className="px-3 py-2 bg-input border border-border rounded text-sm"
							/>
							<button
								type="button"
								onClick={() => fileRef.current?.click()}
								disabled={uploading}
								className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-md text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
							>
								{uploading ? 'Uploading...' : 'Upload'}
							</button>
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

				{/* Unsplash: show picker if licensed, upgrade prompt if not */}
				{unsplashLicensed ? (
					<div className={tab === 'unsplash' ? '' : 'hidden'}>
						<UnsplashPicker onSave={fetchMedia} />
					</div>
				) : tab === 'unsplash' ? (
					<UpgradePrompt feature="Unsplash Integration" plan="Pro" />
				) : null}
				{tab === 'uploaded' && (<div className="flex flex-col flex-1">
				{!ready ? (
					<div />
				) : items.length === 0 ? (
					<div className="flex flex-col items-center pt-[15vh] text-center">
						<div className="w-14 h-14 rounded-2xl bg-surface-alt flex items-center justify-center mb-4">
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
								<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
								<circle cx="8.5" cy="8.5" r="1.5" />
								<polyline points="21 15 16 10 5 21" />
							</svg>
						</div>
						<h3 className="font-semibold text-text mb-1">No media files yet</h3>
						<p className="text-sm text-text-secondary max-w-xs mb-5">
							Upload images, videos, or files by dragging them into the drop zone or clicking Upload.
						</p>
						<button
							type="button"
							onClick={() => fileRef.current?.click()}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
						>
							Upload Your First File
						</button>
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
								{item.type === 'image' ? (
									<img
										src={item.url}
										alt={item.alt || item.filename}
										className="w-full h-full object-cover"
									/>
								) : (
									<div className="flex items-center justify-center h-full bg-surface text-text-secondary text-xs">
										{item.type === 'video' ? 'Video' : 'File'}
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

				{/* Drop zone at bottom */}
				<div className="mt-auto pt-4">
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
					Drop files here or click Upload
				</div>
				</div>
				</div>)}
			</div>

			{/* Detail panel */}
			{selected && (
				<div className="w-72 border-l border-border p-6 space-y-4 overflow-auto">
					<h3 className="font-semibold text-sm">Details</h3>
					{selected.type === 'image' && (
						<img
							src={selected.url}
							alt={selected.alt || ''}
							className="w-full rounded"
						/>
					)}
					<dl className="text-sm space-y-2">
						<dt className="text-text-secondary">Filename</dt>
						<dd className="break-all">{selected.filename}</dd>
						<dt className="text-text-secondary">Type</dt>
						<dd>{selected.mimeType}</dd>
						<dt className="text-text-secondary">Size</dt>
						<dd>{formatSize(selected.size)}</dd>
						<dt className="text-text-secondary">URL</dt>
						<dd>
							<button
								type="button"
								onClick={() => {
									navigator.clipboard.writeText(selected.url)
								}}
								className="text-xs text-blue-400 hover:text-blue-300"
							>
								Copy URL
							</button>
						</dd>
						<dt className="text-text-secondary">Uploaded</dt>
						<dd>{new Date(selected.createdAt).toLocaleString()}</dd>
					</dl>
					<div className="pt-4 border-t border-border flex gap-2">
						<button
							type="button"
							onClick={() => deleteMedia(selected.id)}
							className="px-3 py-1.5 bg-danger-surface text-danger rounded text-sm hover:opacity-80"
						>
							Delete
						</button>
						<button
							type="button"
							onClick={() => setSelected(null)}
							className="px-3 py-1.5 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover"
						>
							Close
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
