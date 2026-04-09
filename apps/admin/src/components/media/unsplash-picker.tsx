import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../../lib/api-client'

interface UnsplashPhoto {
	id: string
	url: string
	thumbUrl: string
	width: number
	height: number
	color: string
	alt: string
	author: string
	authorUsername: string
	authorUrl: string
	unsplashUrl: string
}

interface UnsplashPickerProps {
	onSelect: (photo: UnsplashPhoto) => void
}

export function UnsplashPicker({ onSelect }: UnsplashPickerProps) {
	const [query, setQuery] = useState('')
	const [photos, setPhotos] = useState<UnsplashPhoto[]>([])
	const [loading, setLoading] = useState(false)
	const [page, setPage] = useState(1)
	const [totalPages, setTotalPages] = useState(0)
	const [enabled, setEnabled] = useState<boolean | null>(null)
	const debounceRef = useRef<ReturnType<typeof setTimeout>>()

	useEffect(() => {
		api.get<{ enabled: boolean }>('/api/v1/unsplash/status')
			.then((res) => setEnabled(res.enabled))
			.catch(() => setEnabled(false))
	}, [])

	const search = useCallback(
		async (q: string, p: number) => {
			if (!q.trim()) {
				setPhotos([])
				return
			}
			setLoading(true)
			try {
				const res = await api.get<{
					results: UnsplashPhoto[]
					totalPages: number
				}>(`/api/v1/unsplash/search?q=${encodeURIComponent(q)}&page=${p}`)
				if (p === 1) {
					setPhotos(res.results)
				} else {
					setPhotos((prev) => [...prev, ...res.results])
				}
				setTotalPages(res.totalPages)
			} catch {
				// Silent fail
			} finally {
				setLoading(false)
			}
		},
		[],
	)

	const handleInput = (value: string) => {
		setQuery(value)
		setPage(1)
		if (debounceRef.current) clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => search(value, 1), 300)
	}

	const loadMore = () => {
		const next = page + 1
		setPage(next)
		search(query, next)
	}

	const handleSelect = async (photo: UnsplashPhoto) => {
		// Trigger download tracking (required by Unsplash)
		api.post(`/api/v1/unsplash/download/${photo.id}`, {}).catch(() => {})
		onSelect(photo)
	}

	if (enabled === null) return <p className="text-zinc-500 text-sm p-4">Checking Unsplash...</p>
	if (!enabled) {
		return (
			<div className="p-8 text-center text-zinc-500 text-sm">
				<p>Unsplash not configured.</p>
				<p className="text-xs mt-1">Set <code className="bg-zinc-100 px-1 rounded">UNSPLASH_ACCESS_KEY</code> to enable.</p>
			</div>
		)
	}

	return (
		<div className="space-y-4">
			<input
				type="text"
				value={query}
				onChange={(e) => handleInput(e.target.value)}
				placeholder="Search Unsplash photos..."
				className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-lg text-sm focus:outline-none focus:border-zinc-600"
				autoFocus
			/>

			{photos.length === 0 && !loading && query && (
				<p className="text-zinc-600 text-sm text-center py-4">No photos found.</p>
			)}

			{photos.length === 0 && !loading && !query && (
				<p className="text-zinc-600 text-sm text-center py-4">Type to search free photos on Unsplash.</p>
			)}

			<div className="grid grid-cols-2 md:grid-cols-3 gap-2">
				{photos.map((photo) => (
					<button
						type="button"
						key={photo.id}
						onClick={() => handleSelect(photo)}
						className="group relative aspect-[4/3] rounded-lg overflow-hidden border border-zinc-200 hover:border-zinc-600 transition-colors"
						style={{ backgroundColor: photo.color }}
					>
						<img
							src={photo.thumbUrl}
							alt={photo.alt}
							className="w-full h-full object-cover"
							loading="lazy"
						/>
						<div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
							<p className="text-[10px] text-zinc-900 truncate">
								{photo.author}
							</p>
						</div>
					</button>
				))}
			</div>

			{loading && (
				<div className="flex justify-center py-4">
					<div className="flex gap-1">
						<span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse" />
						<span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse [animation-delay:150ms]" />
						<span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-pulse [animation-delay:300ms]" />
					</div>
				</div>
			)}

			{page < totalPages && !loading && photos.length > 0 && (
				<button
					type="button"
					onClick={loadMore}
					className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
				>
					Load more
				</button>
			)}

			{photos.length > 0 && (
				<p className="text-[10px] text-zinc-300 text-center">
					Photos by <a href="https://unsplash.com" target="_blank" rel="noopener noreferrer" className="underline">Unsplash</a>
				</p>
			)}
		</div>
	)
}
