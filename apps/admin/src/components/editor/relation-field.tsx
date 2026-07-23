import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useCollections } from '../../lib/collections'
import { pickTitleField, resolveDisplayTitle } from '../../lib/display-title'
import { useToast } from '../../lib/toast'

interface RelatedDoc {
	id: string
	externalId?: string
	metadata: Record<string, unknown>
}

interface RelationFieldProps {
	value: string
	relationTo?: string
	disabled?: boolean
	onChange: (value: string) => void
	/**
	 * Render a large, full-width image preview above the picker instead of the small
	 * inline thumbnail. Used for a record's primary image (e.g. featuredImage) in the
	 * editor sidebar.
	 */
	imagePreview?: boolean
}

/**
 * Image/file-URL field detection. The previous version matched a bare `url`
 * substring, which incorrectly classified `courseUrl` (a website link) as an
 * image and rendered an "Upload image" button on the Education Courses relation
 * picker. Now requires an explicit image/photo/thumbnail/file/etc. token; a
 * plain "url" segment must be paired with image/photo (e.g. `imageUrl`,
 * `image_url`, `photoUrl`).
 */
const URL_FIELD_PATTERN =
	/(^|_)(image|imageurl|image_url|photo|photourl|photo_url|thumbnail|thumb|avatar|cover|banner|logo|src|secure_url|file|filename|attachment|asset|path|fullpath|key)($|_)/i

/** Split camelCase so `fullPath`/`imageUrl` match the `_`-delimited field patterns. */
const splitCamel = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')

/**
 * Pick the field in a related collection most likely to hold an image/file URL.
 *
 * The import wizard's `mediaPathColumn` is authoritative when present — it's what
 * the server actually resolves to a servable URL on read. Everything after it is
 * a name heuristic for collections with no media-storage entry.
 */
export function pickUrlField(collection: {
	fields: { name: string; type: string }[]
	mediaPathColumn?: string | null
}): string | undefined {
	const { fields, mediaPathColumn } = collection
	if (mediaPathColumn && fields.some((f) => f.name === mediaPathColumn)) return mediaPathColumn
	const textFields = fields.filter((f) => f.type === 'text' || f.type === 'string')
	// Prefer an explicit image/photo/thumbnail token, then fall back to a field named
	// exactly `url`/`src`/`href` — media-backed collections store the asset URL in a
	// plain `url` column. The exact-name check keeps `courseUrl` (a website link) from
	// being misread as an image, which the bare-substring match used to do.
	return (
		textFields.find((f) => URL_FIELD_PATTERN.test(splitCamel(f.name)))?.name ??
		textFields.find((f) => /^(url|src|href)$/i.test(f.name))?.name
	)
}

/** Resolve a possibly-localized ({ en, ua, … }) value to a plain display string. */
function resolveText(raw: unknown): string {
	if (raw == null) return ''
	if (typeof raw === 'string') return raw
	if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
	if (typeof raw === 'object') {
		const obj = raw as Record<string, unknown>
		const pref = obj.en ?? obj.ua ?? Object.values(obj)[0]
		return typeof pref === 'string' ? pref : ''
	}
	return ''
}

/** True when a string is usable as an <img> src (absolute URL, root path, or data URI). */
function isImageUrl(value: string): boolean {
	return /^(https?:\/\/|\/|data:image\/)/i.test(value.trim())
}

function docId(doc: RelatedDoc): string {
	return doc.externalId || doc.id
}

function ImagePlaceholderIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<path d="m21 15-5-5L5 21" />
		</svg>
	)
}

/** Render an image, falling back to a placeholder icon for non-URL values or load errors. */
function Thumb({ url, className }: { url: string; className: string }) {
	const [failed, setFailed] = useState(false)
	if (url && isImageUrl(url) && !failed) {
		return <img src={url} alt="" className={className} onError={() => setFailed(true)} />
	}
	return (
		<div className={`${className} flex items-center justify-center bg-input`}>
			<ImagePlaceholderIcon className="h-1/2 w-1/2 text-text-muted" />
		</div>
	)
}

export function RelationField({
	value,
	relationTo,
	disabled,
	onChange,
	imagePreview,
}: RelationFieldProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const { getCollectionByName } = useCollections()
	const related = relationTo ? getCollectionByName(relationTo) : undefined

	const [docs, setDocs] = useState<RelatedDoc[]>([])
	const [loading, setLoading] = useState(false)
	const [open, setOpen] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [creating, setCreating] = useState(false)
	const [createName, setCreateName] = useState('')
	const [createSaving, setCreateSaving] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const createInputRef = useRef<HTMLInputElement>(null)

	const urlField = useMemo(() => (related ? pickUrlField(related) : undefined), [related])
	// Field used both for displaying the row label AND for the inline "create new" form;
	// honours the collection's pinned titleField when set.
	const labelField = useMemo(
		() => (related ? (pickTitleField(related) ?? undefined) : undefined),
		[related],
	)
	const canWrite = related?.accessMode === 'read-write'

	/** Resolve a related doc to its display label using the shared resolver. */
	const docLabel = useCallback(
		(doc: RelatedDoc): string => {
			if (!related) return docId(doc)
			return resolveDisplayTitle(
				{ id: docId(doc), slug: doc.externalId ?? null, metadata: doc.metadata },
				related,
			)
		},
		[related],
	)

	const loadDocs = useCallback(() => {
		if (!related) return
		setLoading(true)
		api
			.get<{ data: RelatedDoc[] }>(`/api/v1/content?collectionId=${related.id}&limit=100`)
			.then((res) => setDocs(res.data || []))
			.catch(() => setDocs([]))
			.finally(() => setLoading(false))
	}, [related])

	useEffect(() => {
		loadDocs()
	}, [loadDocs])

	useEffect(() => {
		if (creating) createInputRef.current?.focus()
	}, [creating])

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [open])

	const current = docs.find((d) => docId(d) === value)
	const currentUrl = current && urlField ? resolveText(current.metadata[urlField]) : ''

	const handleUpload = async (file: File) => {
		if (!related || !urlField) return
		setUploading(true)
		try {
			const form = new FormData()
			form.append('file', file)
			const uploaded = await api.upload<{ url: string }>('/api/v1/media/upload', form)
			const created = await api.post<{ _id: string }>('/api/v1/content/relation-records', {
				relationTo,
				values: { [urlField]: uploaded.url },
			})
			onChange(created._id)
			loadDocs()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('editor.relationField.uploadFailed'), 'error')
		} finally {
			setUploading(false)
		}
	}

	const handleCreate = async () => {
		if (!related || !labelField || !createName.trim() || createSaving) return
		setCreateSaving(true)
		try {
			const created = await api.post<{ _id: string }>('/api/v1/content/relation-records', {
				relationTo,
				values: { [labelField]: createName.trim() },
			})
			onChange(created._id)
			setCreating(false)
			setCreateName('')
			loadDocs()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('editor.relationField.createFailed'), 'error')
		} finally {
			setCreateSaving(false)
		}
	}

	// Related collection not imported — fall back to a plain id input with a hint.
	if (!related) {
		return (
			<div>
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong font-mono disabled:opacity-60"
				/>
				<p className="mt-1 text-[10px] text-text-muted">
					{relationTo
						? t('editor.relationField.relatedNotImported', { name: relationTo })
						: t('editor.relationField.noRelatedCollection')}
				</p>
			</div>
		)
	}

	// "Create new <label>" modal, shared by both layouts.
	const createDialog = (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 -z-10 cursor-default"
				onClick={() => setCreating(false)}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('editor.relationField.newDialogTitle', { label: related.label })}
				className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-3"
			>
				<h3 className="text-sm font-semibold">
					{t('editor.relationField.newDialogTitle', { label: related.label })}
				</h3>
				<input
					ref={createInputRef}
					type="text"
					value={createName}
					onChange={(e) => setCreateName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') handleCreate()
						if (e.key === 'Escape') setCreating(false)
					}}
					placeholder={labelField || t('editor.relationField.namePlaceholder')}
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
				/>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={() => setCreating(false)}
						className="px-3 py-1.5 text-text-secondary hover:text-text text-xs"
					>
						{t('common.cancel')}
					</button>
					<button
						type="button"
						onClick={handleCreate}
						disabled={createSaving || !createName.trim()}
						className="px-3 py-1.5 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{createSaving ? t('editor.relationField.creating') : t('common.create')}
					</button>
				</div>
			</div>
		</div>
	)

	// Record picker menu, shared by both layouts. The caller positions it — this is
	// just the absolutely-positioned list that drops out of whatever opened it.
	const pickerMenu = (
		<div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-border-strong rounded-lg shadow-xl z-50 max-h-64 overflow-y-auto">
			{value && (
				<button
					type="button"
					onClick={() => {
						onChange('')
						setOpen(false)
					}}
					className="w-full text-left px-3 py-2 text-sm text-text-muted hover:bg-surface-alt hover:text-text"
				>
					{t('editor.relationField.none')}
				</button>
			)}
			{loading ? (
				<p className="px-3 py-2 text-sm text-text-muted">{t('common.loading')}</p>
			) : docs.length === 0 ? (
				<p className="px-3 py-2 text-sm text-text-muted">
					{t('editor.relationField.noRecordsYet')}
				</p>
			) : (
				docs.map((doc) => {
					const id = docId(doc)
					const docUrl = urlField ? resolveText(doc.metadata[urlField]) : ''
					return (
						<button
							key={id}
							type="button"
							onClick={() => {
								onChange(id)
								setOpen(false)
							}}
							className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm transition-colors ${
								id === value
									? 'bg-surface-alt text-text font-medium'
									: 'text-text-secondary hover:bg-surface-alt hover:text-text'
							}`}
						>
							{urlField && (
								<Thumb
									key={docUrl}
									url={docUrl}
									className="h-6 w-6 shrink-0 rounded object-cover"
								/>
							)}
							<span className="truncate">{docLabel(doc)}</span>
						</button>
					)
				})
			)}
			{!disabled && canWrite && labelField && (
				<button
					type="button"
					onClick={() => {
						setOpen(false)
						setCreating(true)
					}}
					className="w-full text-left px-3 py-2 text-sm font-medium text-text hover:bg-surface-alt border-t border-border sticky bottom-0 bg-surface"
				>
					{t('editor.relationField.createNew', { label: related.label })}
				</button>
			)}
		</div>
	)

	// Featured-image mode: a full-width preview above a Choose / Upload / Remove row.
	// Nothing here is gated on `urlField` — when the related collection exposes no
	// detectable file column the preview falls back to a placeholder tile and the
	// picker still works, instead of the field rendering as an empty gap.
	if (imagePreview) {
		return (
			<div className="space-y-1.5">
				<div className="w-full aspect-video rounded border border-border overflow-hidden bg-input">
					<Thumb key={currentUrl} url={currentUrl} className="h-full w-full object-cover" />
				</div>
				{current && <p className="text-[10px] text-text-muted truncate">{docLabel(current)}</p>}
				{!disabled && (
					<div className="relative flex flex-wrap gap-2" ref={ref}>
						<button
							type="button"
							onClick={() => setOpen((o) => !o)}
							className="inline-flex items-center px-2.5 py-1.5 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover"
						>
							{t('editor.relationField.chooseExisting')}
						</button>
						{urlField && canWrite && (
							<label className="inline-flex items-center px-2.5 py-1.5 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover cursor-pointer">
								{uploading
									? t('editor.relationField.uploading')
									: t('editor.relationField.changeImage')}
								<input
									type="file"
									accept="image/*"
									className="hidden"
									disabled={uploading}
									onChange={(e) => {
										const file = e.target.files?.[0]
										if (file) handleUpload(file)
										e.target.value = ''
									}}
								/>
							</label>
						)}
						{value && (
							<button
								type="button"
								onClick={() => onChange('')}
								className="inline-flex items-center px-2.5 py-1.5 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover"
							>
								{t('editor.relationField.removeImage')}
							</button>
						)}
						{open && pickerMenu}
					</div>
				)}
				{creating && createDialog}
			</div>
		)
	}

	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				{urlField && (
					<div className="h-14 w-14 shrink-0 rounded border border-border overflow-hidden">
						<Thumb key={currentUrl} url={currentUrl} className="h-full w-full object-cover" />
					</div>
				)}
				<div className="relative flex-1 min-w-0" ref={ref}>
					<button
						type="button"
						disabled={disabled}
						onClick={() => !disabled && setOpen((o) => !o)}
						className="w-full flex items-center justify-between px-3 py-2 bg-input border border-border rounded text-sm text-left focus:outline-none focus:border-border-strong disabled:opacity-60"
					>
						<span className={`truncate ${current ? 'text-text' : 'text-text-muted'}`}>
							{current
								? docLabel(current)
								: value || t('editor.relationField.selectLabel', { label: related.label })}
						</span>
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className={`text-text-muted shrink-0 ml-2 transition-transform ${open ? 'rotate-180' : ''}`}
							aria-hidden="true"
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>

					{open && !disabled && pickerMenu}
				</div>
			</div>

			{value && <p className="text-[10px] text-text-muted font-mono truncate">{value}</p>}

			{urlField && !disabled && canWrite && (
				<label className="inline-flex items-center px-2 py-1 bg-btn-secondary text-text rounded text-xs hover:bg-btn-secondary-hover cursor-pointer">
					{uploading ? t('editor.relationField.uploading') : t('editor.relationField.uploadImage')}
					<input
						type="file"
						accept="image/*"
						className="hidden"
						disabled={uploading}
						onChange={(e) => {
							const file = e.target.files?.[0]
							if (file) handleUpload(file)
							e.target.value = ''
						}}
					/>
				</label>
			)}

			{creating && createDialog}
		</div>
	)
}
