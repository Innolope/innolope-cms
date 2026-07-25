import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type MediaSource, uploadToSource } from '../../lib/media-sources'
import { useToast } from '../../lib/toast'

/**
 * Upload modal for the media library: a drag-and-drop area plus a browse
 * button, queueing files for review before an explicit upload — the flow the
 * reference CMS media libraries (Strapi's "Add new assets", WordPress's
 * uploader) converge on, instead of jumping straight into the system file
 * dialog.
 *
 * Files are reviewed as a list (thumbnail, name, size, remove) and uploaded
 * sequentially with a per-file outcome. Failures stay in the list with their
 * error message; the modal closes itself only when everything succeeded, so a
 * rejected file (too big, wrong type) can never vanish silently — the old
 * inline flow swallowed per-file errors entirely.
 */

interface QueuedFile {
	/** Identity for dedupe: same name+size+mtime added twice is one entry. */
	key: string
	file: File
	/** Object URL for image previews; null for non-images. Revoked on removal. */
	previewUrl: string | null
	status: 'queued' | 'uploading' | 'done' | 'error'
	error?: string
}

interface UploadModalProps {
	target: MediaSource
	projectId: string
	/** Files dropped on the page before the modal opened (page-wide drop target). */
	initialFiles?: File[]
	onClose: () => void
	/** Called once after a run that uploaded at least one file (refresh the grid). */
	onUploaded: () => void
}

const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`

const toQueued = (file: File): QueuedFile => ({
	key: fileKey(file),
	file,
	previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
	status: 'queued',
})

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UploadModal({
	target,
	projectId,
	initialFiles,
	onClose,
	onUploaded,
}: UploadModalProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const fileRef = useRef<HTMLInputElement>(null)
	const [queue, setQueue] = useState<QueuedFile[]>(() => (initialFiles ?? []).map(toQueued))
	const [dragOver, setDragOver] = useState(false)
	const [busy, setBusy] = useState(false)
	// Reading state from inside the async upload loop needs the latest queue.
	const queueRef = useRef(queue)
	queueRef.current = queue

	// Revoke every preview URL on unmount (removal revokes its own eagerly).
	useEffect(() => {
		return () => {
			for (const q of queueRef.current) {
				if (q.previewUrl) URL.revokeObjectURL(q.previewUrl)
			}
		}
	}, [])

	const close = useCallback(() => {
		if (!busy) onClose()
	}, [busy, onClose])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [close])

	const addFiles = (files: Iterable<File>) => {
		setQueue((prev) => {
			const seen = new Set(prev.map((q) => q.key))
			const added: QueuedFile[] = []
			for (const file of files) {
				const key = fileKey(file)
				if (seen.has(key)) continue
				seen.add(key)
				added.push(toQueued(file))
			}
			return added.length ? [...prev, ...added] : prev
		})
	}

	const removeFile = (key: string) => {
		setQueue((prev) => {
			const entry = prev.find((q) => q.key === key)
			if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl)
			return prev.filter((q) => q.key !== key)
		})
	}

	const setStatus = (key: string, status: QueuedFile['status'], error?: string) => {
		setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, status, error } : q)))
	}

	/**
	 * Upload the queue sequentially (media files are large; parallel uploads
	 * compete for the same uplink and make every progress state ambiguous).
	 * Successes leave the list at the end; failures stay with their message.
	 */
	const uploadAll = async () => {
		const pending = queueRef.current.filter((q) => q.status === 'queued' || q.status === 'error')
		if (pending.length === 0 || busy) return
		setBusy(true)
		let succeeded = 0
		for (const item of pending) {
			setStatus(item.key, 'uploading')
			try {
				await uploadToSource(target, item.file, projectId)
				succeeded++
				setStatus(item.key, 'done')
			} catch (err) {
				setStatus(item.key, 'error', err instanceof Error ? err.message : t('common.failed'))
			}
		}
		setBusy(false)
		if (succeeded > 0) onUploaded()

		const failed = pending.length - succeeded
		if (failed === 0) {
			toast(t('mediaRoute.uploadModal.uploadedCount', { count: succeeded }), 'success')
			onClose()
		} else {
			// Keep the modal open on the failures; clear what already made it.
			setQueue((prev) => {
				for (const q of prev) {
					if (q.status === 'done' && q.previewUrl) URL.revokeObjectURL(q.previewUrl)
				}
				return prev.filter((q) => q.status !== 'done')
			})
			toast(t('mediaRoute.uploadModal.partialFailed', { failed, total: pending.length }), 'error')
		}
	}

	const pendingCount = queue.filter((q) => q.status !== 'done').length

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop surface; keyboard users upload via the Browse files button.
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			// The whole modal surface accepts drops — aiming precisely at the inner
			// dashed box during a drag is needless friction.
			onDragOver={(e) => {
				e.preventDefault()
				setDragOver(true)
			}}
			onDragLeave={(e) => {
				if (e.target === e.currentTarget) setDragOver(false)
			}}
			onDrop={(e) => {
				e.preventDefault()
				setDragOver(false)
				if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
			}}
		>
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 -z-10 cursor-default"
				onClick={close}
				disabled={busy}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('mediaRoute.uploadModal.title')}
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-xl p-6 flex flex-col max-h-[85vh]"
			>
				<div className="flex items-start justify-between mb-4">
					<div>
						<h3 className="text-lg font-semibold text-text">{t('mediaRoute.uploadModal.title')}</h3>
						{/* Say where the bytes will land — a project can have several
						    writable libraries and silent misdirection is hard to undo. */}
						<p className="text-xs text-text-muted mt-0.5">
							{t('mediaRoute.uploadModal.destination', { target: target.label })}
						</p>
					</div>
					<button
						type="button"
						onClick={close}
						disabled={busy}
						aria-label={t('common.closeDialog')}
						className="p-1 rounded text-text-muted hover:text-text transition-colors disabled:opacity-40"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				{/* Drop area — compact once files are queued so the list gets the room. */}
				<div
					className={`border-2 border-dashed rounded-lg flex flex-col items-center justify-center text-center transition-colors ${
						queue.length === 0 ? 'py-12 px-6' : 'py-5 px-6'
					} ${dragOver ? 'border-text bg-surface-alt' : 'border-border'}`}
				>
					<svg
						width="28"
						height="28"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className={`text-text-muted mb-2 ${queue.length === 0 ? '' : 'hidden'}`}
					>
						<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
						<polyline points="17 8 12 3 7 8" />
						<line x1="12" y1="3" x2="12" y2="15" />
					</svg>
					<p className="text-sm text-text-secondary">{t('mediaRoute.uploadModal.dropHint')}</p>
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						disabled={busy}
						className="mt-2.5 px-3 py-1.5 bg-btn-secondary text-text-secondary rounded-md text-sm font-medium hover:bg-btn-secondary-hover transition-colors disabled:opacity-40"
					>
						{t('mediaRoute.uploadModal.browse')}
					</button>
					<input
						ref={fileRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => {
							if (e.target.files?.length) addFiles(e.target.files)
							// Same file picked twice in a row must still fire onChange.
							e.target.value = ''
						}}
					/>
				</div>

				{/* Queue */}
				{queue.length > 0 && (
					<ul className="mt-4 space-y-2 overflow-y-auto min-h-0" aria-live="polite">
						{queue.map((q) => (
							<li
								key={q.key}
								className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface-alt/50"
							>
								{q.previewUrl ? (
									<img
										src={q.previewUrl}
										alt=""
										className="w-10 h-10 rounded object-cover shrink-0"
									/>
								) : (
									<div className="w-10 h-10 rounded bg-surface-alt flex items-center justify-center text-[10px] text-text-muted shrink-0 uppercase">
										{q.file.name.split('.').pop()?.slice(0, 4) || 'file'}
									</div>
								)}
								<div className="min-w-0 flex-1">
									<p className="text-sm text-text truncate">{q.file.name}</p>
									<p className="text-xs text-text-muted">
										{formatFileSize(q.file.size)}
										{q.status === 'error' && q.error && (
											<span className="text-danger ml-2">{q.error}</span>
										)}
									</p>
								</div>
								{q.status === 'uploading' && (
									<span
										className="w-4 h-4 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin text-text-muted"
										role="status"
										aria-label={t('mediaRoute.uploading')}
									/>
								)}
								{q.status === 'done' && (
									<svg
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										className="text-green-600 shrink-0"
										aria-hidden="true"
									>
										<polyline points="20 6 9 17 4 12" />
									</svg>
								)}
								{(q.status === 'queued' || q.status === 'error') && !busy && (
									<button
										type="button"
										onClick={() => removeFile(q.key)}
										aria-label={t('mediaRoute.uploadModal.remove', { name: q.file.name })}
										className="p-1 rounded text-text-muted hover:text-danger transition-colors shrink-0"
									>
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
										>
											<line x1="18" y1="6" x2="6" y2="18" />
											<line x1="6" y1="6" x2="18" y2="18" />
										</svg>
									</button>
								)}
							</li>
						))}
					</ul>
				)}

				<div className="flex justify-end gap-3 mt-5">
					<button
						type="button"
						onClick={close}
						disabled={busy}
						className="px-4 py-2 bg-btn-secondary text-text-secondary rounded-lg text-sm hover:bg-btn-secondary-hover transition-colors disabled:opacity-40"
					>
						{t('common.cancel')}
					</button>
					<button
						type="button"
						onClick={uploadAll}
						disabled={busy || pendingCount === 0}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors disabled:opacity-50"
					>
						{busy
							? t('mediaRoute.uploading')
							: t('mediaRoute.uploadModal.uploadCount', { count: pendingCount })}
					</button>
				</div>
			</div>
		</div>
	)
}
