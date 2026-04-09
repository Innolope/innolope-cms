import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api-client'
import { UnsplashPicker } from '../components/media/unsplash-picker'

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
	const [tab, setTab] = useState<'uploaded' | 'unsplash'>('uploaded')
	const [items, setItems] = useState<MediaItem[]>([])
	const [loading, setLoading] = useState(true)
	const [uploading, setUploading] = useState(false)
	const [selected, setSelected] = useState<MediaItem | null>(null)
	const [typeFilter, setTypeFilter] = useState('')
	const fileRef = useRef<HTMLInputElement>(null)

	const fetchMedia = () => {
		const params = new URLSearchParams()
		params.set('limit', '50')
		if (typeFilter) params.set('type', typeFilter)

		setLoading(true)
		api.get<{ data: MediaItem[] }>(`/api/v1/media?${params}`)
			.then((res) => setItems(res.data))
			.catch(() => {})
			.finally(() => setLoading(false))
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
			<div className="flex-1 overflow-auto p-8">
				<div className="flex items-center justify-between mb-6">
					<div className="flex items-center gap-4">
						<h2 className="text-2xl font-bold">Media</h2>
						<div className="flex bg-white rounded-lg p-0.5">
							<button
								type="button"
								onClick={() => setTab('uploaded')}
								className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${tab === 'uploaded' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-300'}`}
							>
								Uploaded
							</button>
							<button
								type="button"
								onClick={() => setTab('unsplash')}
								className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${tab === 'unsplash' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-300'}`}
							>
								Unsplash
							</button>
						</div>
					</div>
					<div className="flex gap-3">
						<select
							value={typeFilter}
							onChange={(e) => setTypeFilter(e.target.value)}
							className="px-3 py-2 bg-white border border-zinc-200 rounded text-sm"
						>
							<option value="">All types</option>
							<option value="image">Images</option>
							<option value="video">Videos</option>
							<option value="file">Files</option>
						</select>
						<button
							type="button"
							onClick={() => fileRef.current?.click()}
							disabled={uploading}
							className="px-4 py-2 bg-zinc-900 text-white rounded-md text-sm font-medium hover:bg-zinc-800 disabled:opacity-50"
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
				</div>

				{tab === 'unsplash' ? (
					<UnsplashPicker onSelect={(photo) => {
						navigator.clipboard.writeText(photo.url)
						alert(`Copied URL for "${photo.alt}" by ${photo.author}`)
					}} />
				) : (<>
				{/* Drop zone */}
				<div
					className="mb-4 border-2 border-dashed border-zinc-200 rounded-lg p-6 text-center text-zinc-600 text-sm hover:border-zinc-600 transition-colors"
					onDragOver={(e) => {
						e.preventDefault()
						e.currentTarget.classList.add('border-zinc-500')
					}}
					onDragLeave={(e) => {
						e.currentTarget.classList.remove('border-zinc-500')
					}}
					onDrop={(e) => {
						e.preventDefault()
						e.currentTarget.classList.remove('border-zinc-500')
						if (e.dataTransfer.files.length) upload(e.dataTransfer.files)
					}}
				>
					Drop files here or click Upload
				</div>

				{loading ? (
					<p className="text-zinc-500 text-sm">Loading...</p>
				) : items.length === 0 ? (
					<p className="text-zinc-500 text-sm">No media files yet.</p>
				) : (
					<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
						{items.map((item) => (
							<button
								type="button"
								key={item.id}
								onClick={() => setSelected(item)}
								className={`group relative aspect-square rounded-lg overflow-hidden border transition-colors ${
									selected?.id === item.id
										? 'border-white'
										: 'border-zinc-200 hover:border-zinc-600'
								}`}
							>
								{item.type === 'image' ? (
									<img
										src={item.url}
										alt={item.alt || item.filename}
										className="w-full h-full object-cover"
									/>
								) : (
									<div className="flex items-center justify-center h-full bg-white text-zinc-500 text-xs">
										{item.type === 'video' ? 'Video' : 'File'}
										<br />
										{item.filename}
									</div>
								)}
								<div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1 text-xs truncate opacity-0 group-hover:opacity-100 transition-opacity">
									{item.filename}
								</div>
							</button>
						))}
					</div>
				)}
				</>)}
			</div>

			{/* Detail panel */}
			{selected && (
				<div className="w-72 border-l border-zinc-200 p-6 space-y-4 overflow-auto">
					<h3 className="font-semibold text-sm">Details</h3>
					{selected.type === 'image' && (
						<img
							src={selected.url}
							alt={selected.alt || ''}
							className="w-full rounded"
						/>
					)}
					<dl className="text-sm space-y-2">
						<dt className="text-zinc-500">Filename</dt>
						<dd className="break-all">{selected.filename}</dd>
						<dt className="text-zinc-500">Type</dt>
						<dd>{selected.mimeType}</dd>
						<dt className="text-zinc-500">Size</dt>
						<dd>{formatSize(selected.size)}</dd>
						<dt className="text-zinc-500">URL</dt>
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
						<dt className="text-zinc-500">Uploaded</dt>
						<dd>{new Date(selected.createdAt).toLocaleString()}</dd>
					</dl>
					<div className="pt-4 border-t border-zinc-200 flex gap-2">
						<button
							type="button"
							onClick={() => deleteMedia(selected.id)}
							className="px-3 py-1.5 bg-red-50 text-red-600 rounded text-sm hover:bg-red-100"
						>
							Delete
						</button>
						<button
							type="button"
							onClick={() => setSelected(null)}
							className="px-3 py-1.5 bg-zinc-100 rounded text-sm hover:bg-zinc-200"
						>
							Close
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
