import { useState } from 'react'
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

type Tab = 'url' | 'unsplash'

export function ImagePickerModal({ onSelect, onClose }: ImagePickerModalProps) {
	const [tab, setTab] = useState<Tab>('unsplash')
	const [url, setUrl] = useState('')
	const [alt, setAlt] = useState('')

	const handleUrlSubmit = () => {
		if (!url.trim()) return
		onSelect({ url, alt: alt || '' })
		onClose()
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
			<div
				className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-5 py-4 border-b border-border">
					<h3 className="text-sm font-semibold">Insert Image</h3>
					<button
						type="button"
						onClick={onClose}
						className="text-text-secondary hover:text-text text-xs"
					>
						Close
					</button>
				</div>

				{/* Tabs */}
				<div className="flex border-b border-border">
					<TabButton active={tab === 'unsplash'} onClick={() => setTab('unsplash')}>
						Unsplash
					</TabButton>
					<TabButton active={tab === 'url'} onClick={() => setTab('url')}>
						URL
					</TabButton>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-auto p-4">
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
								<label className="block text-xs text-text-secondary mb-1.5">Image URL</label>
								<input
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
								<label className="block text-xs text-text-secondary mb-1.5">Alt text (optional)</label>
								<input
									type="text"
									value={alt}
									onChange={(e) => setAlt(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
									placeholder="Describe the image"
									className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
								/>
							</div>
							<button
								type="button"
								onClick={handleUrlSubmit}
								disabled={!url.trim()}
								className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-30 transition-colors"
							>
								Insert Image
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
				active
					? 'text-text border-b-2 border-text'
					: 'text-text-secondary hover:text-text-muted'
			}`}
		>
			{children}
		</button>
	)
}
