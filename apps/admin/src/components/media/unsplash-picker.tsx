import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../../lib/api-client'
import { useToast } from '../../lib/toast'

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
	onSave?: () => void
	onSelect?: (photo: UnsplashPhoto) => void
}

export function UnsplashPicker({ onSave, onSelect }: UnsplashPickerProps) {
	const toast = useToast()
	const [query, setQuery] = useState('')
	const [photos, setPhotos] = useState<UnsplashPhoto[]>([])
	const [loading, setLoading] = useState(false)
	const [page, setPage] = useState(1)
	const [totalPages, setTotalPages] = useState(0)
	const [enabled, setEnabled] = useState<boolean | null>(null)
	const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
	const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
	const debounceRef = useRef<ReturnType<typeof setTimeout>>()

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

	useEffect(() => {
		api.get<{ enabled: boolean }>('/api/v1/unsplash/status')
			.then((res) => {
				setEnabled(res.enabled)
				if (res.enabled) search('Hello', 1)
			})
			.catch(() => setEnabled(false))
	}, [search])

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

	const savePhoto = async (photo: UnsplashPhoto) => {
		if (savingIds.has(photo.id) || savedIds.has(photo.id)) return

		setSavingIds((prev) => new Set(prev).add(photo.id))
		try {
			await api.post(`/api/v1/unsplash/save/${photo.id}`, {})
			setSavedIds((prev) => new Set(prev).add(photo.id))
			toast(`Saved "${photo.alt || 'photo'}" by ${photo.author}`, 'success')
			onSave?.()
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Failed to save photo', 'error')
		} finally {
			setSavingIds((prev) => {
				const next = new Set(prev)
				next.delete(photo.id)
				return next
			})
		}
	}

	if (enabled === null) return <p className="text-text-secondary text-sm p-4">Checking Unsplash...</p>
	if (!enabled) {
		return (
			<div className="p-8 text-center text-text-secondary text-sm">
				<p>Unsplash not configured.</p>
				<p className="text-xs mt-1">Set <code className="bg-surface-alt px-1 rounded">UNSPLASH_ACCESS_KEY</code> to enable.</p>
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
				className="w-full px-3 py-2 bg-input border border-border rounded-lg text-sm focus:outline-none focus:border-border-strong"
				autoFocus
			/>

			{photos.length === 0 && !loading && query && (
				<p className="text-text-secondary text-sm text-center py-4">No photos found.</p>
			)}

			{photos.length === 0 && !loading && !query && (
				<p className="text-text-secondary text-sm text-center py-4">Search free photos on Unsplash.</p>
			)}

			<div className="grid grid-cols-2 md:grid-cols-3 gap-2">
				{photos.map((photo) => {
					const isSaving = savingIds.has(photo.id)
					const isSaved = savedIds.has(photo.id)

					return (
						<div
							key={photo.id}
							className={`group relative aspect-[4/3] rounded-lg overflow-hidden border border-border hover:border-text-muted transition-colors ${onSelect ? 'cursor-pointer' : ''}`}
							style={{ backgroundColor: photo.color }}
							onClick={onSelect ? () => { api.post(`/api/v1/unsplash/download/${photo.id}`, {}).catch(() => {}); onSelect(photo) } : undefined}
						>
							<img
								src={photo.thumbUrl}
								alt={photo.alt}
								className="w-full h-full object-cover"
								loading="lazy"
							/>

							{/* Save button overlay */}
							<button
								type="button"
								onClick={() => savePhoto(photo)}
								disabled={isSaving || isSaved}
								className={`absolute top-2 right-2 p-1.5 rounded-md transition-all ${
									isSaved
										? 'bg-white/90 text-green-600 opacity-100'
										: 'bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-black/70'
								} disabled:cursor-default`}
								title={isSaved ? 'Saved to library' : 'Save to library'}
							>
								{isSaving ? (
									<svg width="16" height="16" viewBox="0 0 16 16" className="animate-spin">
										<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
									</svg>
								) : isSaved ? (
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<polyline points="20 6 9 17 4 12" />
									</svg>
								) : (
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
									</svg>
								)}
							</button>

							{/* Author attribution */}
							<div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
								<p className="text-[10px] text-white truncate">
									{photo.author}
								</p>
							</div>
						</div>
					)
				})}
			</div>

			{loading && (
				<div className="flex justify-center py-4">
					<div className="flex gap-1">
						<span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse" />
						<span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:150ms]" />
						<span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:300ms]" />
					</div>
				</div>
			)}

			{page < totalPages && !loading && photos.length > 0 && (
				<button
					type="button"
					onClick={loadMore}
					className="w-full py-2 text-xs text-text-secondary hover:text-text-muted transition-colors"
				>
					Load more
				</button>
			)}

			{photos.length > 0 && (
				<p className="text-[10px] text-text-faint text-center">
					Photos by <a href="https://unsplash.com" target="_blank" rel="noopener noreferrer" className="underline">Unsplash</a>
				</p>
			)}
		</div>
	)
}
