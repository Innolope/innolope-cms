import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../lib/auth'
import { useCollections } from '../../lib/collections'
import {
	canUploadTo,
	fetchMediaAssets,
	listMediaSources,
	type MediaAsset,
	PROJECT_LIBRARY_ID,
	uploadToSource,
} from '../../lib/media-sources'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'
import { ImageThumb } from '../media/image-thumb'
import { UnsplashPicker } from '../media/unsplash-picker'

export interface ImageSelection {
	url: string
	alt: string
	attribution?: {
		author: string
		authorUrl: string
		source: 'unsplash'
	}
}

interface ImagePickerModalProps {
	onSelect: (image: ImageSelection) => void
	onClose: () => void
}

type Tab = 'library' | 'url' | 'unsplash'

export function ImagePickerModal({ onSelect, onClose }: ImagePickerModalProps) {
	const { t } = useTranslation()
	// The project's own images come first — before this tab existed the only ways
	// to put an image in an article body were a stock photo or a hand-typed URL.
	const [tab, setTab] = useState<Tab>('library')
	const [url, setUrl] = useState('')
	const [alt, setAlt] = useState('')
	const toast = useToast()
	const { collections } = useCollections()
	const { currentProject } = useAuth()
	const fileRef = useRef<HTMLInputElement>(null)

	const sources = listMediaSources(collections, t('mediaRoute.sources.library'))
	const [sourceId, setSourceId] = useState<string>(PROJECT_LIBRARY_ID)
	const [assets, setAssets] = useState<MediaAsset[]>([])
	const [loadingAssets, setLoadingAssets] = useState(false)
	const [uploading, setUploading] = useState(false)

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the source id; `sources` is rebuilt every render.
	const loadAssets = useCallback(() => {
		const source = sources.find((s) => s.id === sourceId) ?? sources[0]
		if (!source) return
		setLoadingAssets(true)
		fetchMediaAssets(source, { limit: 60, type: source.collection ? undefined : 'image' })
			.then(setAssets)
			.catch(() => setAssets([]))
			.finally(() => setLoadingAssets(false))
	}, [sourceId])

	useEffect(() => {
		if (tab === 'library') loadAssets()
	}, [tab, loadAssets])

	const handleUpload = async (file: File) => {
		const source = sources.find((s) => s.id === sourceId) ?? sources[0]
		if (!source || !currentProject) return
		setUploading(true)
		try {
			await uploadToSource(source, file, currentProject.id)
			loadAssets()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('editor.relationField.uploadFailed'), 'error')
		} finally {
			setUploading(false)
		}
	}

	const handleUrlSubmit = () => {
		if (!url.trim()) return
		onSelect({ url, alt: alt || '' })
		onClose()
	}

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [onClose])

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 -z-10 cursor-default"
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('editor.imagePicker.title')}
				className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
			>
				{/* Header */}
				<div className="flex items-center justify-between px-5 py-4 border-b border-border">
					<h3 className="text-sm font-semibold">{t('editor.imagePicker.title')}</h3>
					<button
						type="button"
						onClick={onClose}
						className="text-text-secondary hover:text-text text-xs"
					>
						{t('editor.imagePicker.close')}
					</button>
				</div>

				{/* Tabs */}
				<div className="flex border-b border-border">
					<TabButton active={tab === 'library'} onClick={() => setTab('library')}>
						{t('editor.imagePicker.tabs.library')}
					</TabButton>
					<TabButton active={tab === 'unsplash'} onClick={() => setTab('unsplash')}>
						{t('editor.imagePicker.tabs.unsplash')}
					</TabButton>
					<TabButton active={tab === 'url'} onClick={() => setTab('url')}>
						{t('editor.imagePicker.tabs.url')}
					</TabButton>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-auto p-4">
					{tab === 'library' && (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								{sources.length > 1 && (
									<Dropdown
										value={sourceId}
										onChange={setSourceId}
										options={sources.map((s) => ({ value: s.id, label: s.label }))}
										className="flex-1"
									/>
								)}
								{canUploadTo(sources.find((s) => s.id === sourceId)) && (
									<>
										<button
											type="button"
											onClick={() => fileRef.current?.click()}
											disabled={uploading}
											className="px-3 py-2 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover disabled:opacity-50 shrink-0"
										>
											{uploading
												? t('editor.relationField.uploading')
												: t('editor.imagePicker.uploadNew')}
										</button>
										<input
											ref={fileRef}
											type="file"
											accept="image/*"
											className="hidden"
											onChange={(e) => {
												const file = e.target.files?.[0]
												if (file) handleUpload(file)
												e.target.value = ''
											}}
										/>
									</>
								)}
							</div>

							{loadingAssets ? (
								<p className="text-sm text-text-muted py-6 text-center">{t('common.loading')}</p>
							) : assets.length === 0 ? (
								<p className="text-sm text-text-muted py-6 text-center">
									{t('editor.imagePicker.libraryEmpty')}
								</p>
							) : (
								<div className="grid grid-cols-3 gap-2">
									{assets.map((asset) => (
										<button
											type="button"
											key={asset.id}
											onClick={() => {
												onSelect({ url: asset.variants?.medium || asset.url, alt: asset.alt || '' })
												onClose()
											}}
											title={asset.filename}
											className="group relative aspect-square rounded-lg overflow-hidden border border-border hover:border-text-muted transition-colors"
										>
											<ImageThumb
												url={asset.variants?.thumbnail || asset.url}
												alt={asset.alt || asset.filename}
												placeholderLabel={asset.filename}
												className="w-full h-full object-cover"
											/>
											<span className="absolute bottom-0 left-0 right-0 bg-black/70 px-1.5 py-1 text-[10px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
												{asset.filename}
											</span>
										</button>
									))}
								</div>
							)}
						</div>
					)}

					{tab === 'unsplash' && (
						<UnsplashPicker
							onSelect={(photo) => {
								onSelect({
									url: photo.url,
									alt: photo.alt || `Photo by ${photo.author}`,
									attribution: {
										author: photo.author,
										authorUrl: `${photo.authorUrl}?utm_source=innolope_cms&utm_medium=referral`,
										source: 'unsplash',
									},
								})
								onClose()
							}}
						/>
					)}

					{tab === 'url' && (
						<div className="space-y-4">
							<div>
								<label htmlFor="img-url" className="block text-xs text-text-secondary mb-1.5">
									{t('editor.imagePicker.imageUrl')}
								</label>
								<input
									id="img-url"
									type="url"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
									placeholder="https://..."
									className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
									autoFocus
								/>
							</div>
							<div>
								<label htmlFor="img-alt" className="block text-xs text-text-secondary mb-1.5">
									{t('editor.imagePicker.altTextOptional')}
								</label>
								<input
									id="img-alt"
									type="text"
									value={alt}
									onChange={(e) => setAlt(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
									placeholder={t('editor.imagePicker.describeImage')}
									className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
								/>
							</div>
							<button
								type="button"
								onClick={handleUrlSubmit}
								disabled={!url.trim()}
								className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-30 transition-colors"
							>
								{t('editor.imagePicker.insertImage')}
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`px-4 py-2.5 text-xs font-medium transition-colors ${
				active ? 'text-text border-b-2 border-text' : 'text-text-secondary hover:text-text-muted'
			}`}
		>
			{children}
		</button>
	)
}
