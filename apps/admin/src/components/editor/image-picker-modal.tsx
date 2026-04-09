import { useState } from 'react'
import { UnsplashPicker } from '../media/unsplash-picker'

interface ImagePickerModalProps {
	onSelect: (url: string, alt: string) => void
	onClose: () => void
}

type Tab = 'url' | 'unsplash'

export function ImagePickerModal({ onSelect, onClose }: ImagePickerModalProps) {
	const [tab, setTab] = useState<Tab>('unsplash')
	const [url, setUrl] = useState('')
	const [alt, setAlt] = useState('')

	const handleUrlSubmit = () => {
		if (!url.trim()) return
		onSelect(url, alt || '')
		onClose()
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
			<div
				className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
					<h3 className="text-sm font-semibold">Insert Image</h3>
					<button
						type="button"
						onClick={onClose}
						className="text-zinc-600 hover:text-zinc-400 text-xs"
					>
						Close
					</button>
				</div>

				{/* Tabs */}
				<div className="flex border-b border-zinc-800">
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
								onSelect(
									photo.url,
									`Photo by ${photo.author} on Unsplash`,
								)
								onClose()
							}}
						/>
					)}

					{tab === 'url' && (
						<div className="space-y-4">
							<div>
								<label className="block text-xs text-zinc-500 mb-1.5">Image URL</label>
								<input
									type="url"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
									placeholder="https://..."
									className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
									autoFocus
								/>
							</div>
							<div>
								<label className="block text-xs text-zinc-500 mb-1.5">Alt text (optional)</label>
								<input
									type="text"
									value={alt}
									onChange={(e) => setAlt(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
									placeholder="Describe the image"
									className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
								/>
							</div>
							<button
								type="button"
								onClick={handleUrlSubmit}
								disabled={!url.trim()}
								className="px-4 py-2 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-30 transition-colors"
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
					? 'text-white border-b-2 border-white'
					: 'text-zinc-500 hover:text-zinc-300'
			}`}
		>
			{children}
		</button>
	)
}
