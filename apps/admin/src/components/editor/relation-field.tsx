import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useCollections } from '../../lib/collections'
import { pickTitleField, resolveDisplayTitle } from '../../lib/display-title'
import { useToast } from '../../lib/toast'
import { ImageThumb } from '../media/image-thumb'

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

function docId(doc: RelatedDoc): string {
	return doc.externalId || doc.id
}

/** Shared geometry for the small inline glyphs on the image action buttons. */
function Icon({ children }: { children: React.ReactNode }) {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className="shrink-0"
		>
			{children}
		</svg>
	)
}

const IconUpload = (
	<Icon>
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="17 8 12 3 7 8" />
		<line x1="12" y1="3" x2="12" y2="15" />
	</Icon>
)

const IconLibrary = (
	<Icon>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<circle cx="8.5" cy="8.5" r="1.5" />
		<polyline points="21 15 16 10 5 21" />
	</Icon>
)

const IconReplace = (
	<Icon>
		<polyline points="23 4 23 10 17 10" />
		<polyline points="1 20 1 14 7 14" />
		<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
	</Icon>
)

const IconTrash = (
	<Icon>
		<polyline points="3 6 5 6 21 6" />
		<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
		<path d="M10 11v6M14 11v6" />
		<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
	</Icon>
)

const IconClose = (
	<Icon>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</Icon>
)

const imageBtnCls =
	'inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover'

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
	const { currentProject } = useAuth()
	const related = relationTo ? getCollectionByName(relationTo) : undefined

	const [docs, setDocs] = useState<RelatedDoc[]>([])
	const [loading, setLoading] = useState(false)
	const [open, setOpen] = useState(false)
	const [uploading, setUploading] = useState(false)
	// Featured-image mode only: the Replace button has been pressed and the row is
	// showing the "choose existing / upload new" choice.
	const [replacing, setReplacing] = useState(false)
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

	// A new image landed (picked or uploaded) — collapse the replace row back to
	// Replace / Remove so the field returns to its resting state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger, not a read dependency.
	useEffect(() => {
		setReplacing(false)
	}, [value])

	// Click-outside closing only applies to the dropdown; the modal picker has
	// its own backdrop button and would close instantly under this handler.
	useEffect(() => {
		if (!open || urlField) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [open, urlField])

	const current = docs.find((d) => docId(d) === value)
	const currentUrl = current && urlField ? resolveText(current.metadata[urlField]) : ''

	const handleUpload = async (file: File) => {
		if (!related || !urlField) return
		setUploading(true)
		try {
			const form = new FormData()
			form.append('file', file)

			// An imported media library owns its own storage (Cloudflare Images, R2, …)
			// and the rest of its rows point at that storage. Uploading through the
			// project media library instead would put the file on the CMS's own disk
			// and write a path the source database — and the site reading it — can't
			// resolve, so route it into the library's real backing store.
			if (related.mediaPathColumn && currentProject) {
				const created = await api.upload<{ id: string; externalId?: string }>(
					`/api/v1/projects/${currentProject.id}/database/media-upload?collectionId=${related.id}`,
					form,
				)
				onChange(created.externalId || created.id)
				loadDocs()
				return
			}

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
								<ImageThumb
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

	// Image relations swap the cramped dropdown for a modal with real previews —
	// picking a photo from a 6px-tall text row was guesswork.
	const pickerModal = (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 cursor-default"
				onClick={() => setOpen(false)}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('editor.relationField.pickTitle', { label: related.label })}
				className="relative bg-bg border border-border rounded-xl shadow-2xl w-full max-w-2xl p-4 space-y-3"
			>
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">
						{t('editor.relationField.pickTitle', { label: related.label })}
					</h3>
					<button
						type="button"
						onClick={() => setOpen(false)}
						aria-label={t('common.closeDialog')}
						className="rounded p-1 text-text-secondary hover:text-text"
					>
						{IconClose}
					</button>
				</div>
				{loading ? (
					<p className="text-sm text-text-muted">{t('common.loading')}</p>
				) : docs.length === 0 ? (
					<p className="text-sm text-text-muted">{t('editor.relationField.noRecordsYet')}</p>
				) : (
					<div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
						{docs.map((doc) => {
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
									className="text-left"
								>
									<div
										className={`aspect-square overflow-hidden rounded-lg border ${
											id === value
												? 'border-text ring-1 ring-text'
												: 'border-border hover:border-text-muted'
										}`}
									>
										<ImageThumb
											key={docUrl}
											url={docUrl}
											className="h-full w-full object-cover"
											placeholderLabel={docLabel(doc)}
										/>
									</div>
									<p className="mt-1 truncate text-[11px] text-text-secondary">{docLabel(doc)}</p>
								</button>
							)
						})}
					</div>
				)}
				<div className="flex items-center justify-between border-t border-border pt-2.5">
					{value ? (
						<button
							type="button"
							onClick={() => {
								onChange('')
								setOpen(false)
							}}
							className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text"
						>
							{IconTrash}
							{t('editor.relationField.removeImage')}
						</button>
					) : (
						<span />
					)}
					{!disabled && canWrite && labelField && (
						<button
							type="button"
							onClick={() => {
								setOpen(false)
								setCreating(true)
							}}
							className="text-xs font-medium text-text hover:underline"
						>
							{t('editor.relationField.createNew', { label: related.label })}
						</button>
					)}
				</div>
			</div>
		</div>
	)

	// Upload control, shared by both layouts — a <label> wrapping a hidden file input.
	const uploadButton = (labelText: string, className: string) => (
		<label className={`${className} cursor-pointer`}>
			{IconUpload}
			{uploading ? t('editor.relationField.uploading') : labelText}
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
	)

	// Featured-image mode: a full-width preview above the action row.
	// Nothing here is gated on `urlField` — when the related collection exposes no
	// detectable file column the preview falls back to a placeholder tile and the
	// picker still works, instead of the field rendering as an empty gap.
	//
	// With an image set the row stays at two decisions (Replace / Remove) so the
	// destructive one isn't sitting between two ways of picking a photo; Replace
	// then expands into the same source choice an empty field shows up front.
	if (imagePreview) {
		const sourceChoice = (
			<>
				<button type="button" onClick={() => setOpen(true)} className={imageBtnCls}>
					{IconLibrary}
					{t('editor.relationField.chooseExisting')}
				</button>
				{urlField && canWrite && uploadButton(t('editor.relationField.uploadNew'), imageBtnCls)}
				{value && (
					<button
						type="button"
						onClick={() => setReplacing(false)}
						className="px-2 py-1.5 text-xs text-text-secondary hover:text-text"
					>
						{t('common.cancel')}
					</button>
				)}
			</>
		)
		return (
			<div className="space-y-1.5">
				<div className="w-full aspect-video rounded border border-border overflow-hidden bg-input">
					<ImageThumb key={currentUrl} url={currentUrl} className="h-full w-full object-cover" />
				</div>
				{current && <p className="text-[10px] text-text-muted truncate">{docLabel(current)}</p>}
				{!disabled && (
					<div className="relative flex flex-wrap items-center gap-2" ref={ref}>
						{value && !replacing ? (
							<>
								<button type="button" onClick={() => setReplacing(true)} className={imageBtnCls}>
									{IconReplace}
									{t('editor.relationField.replaceImage')}
								</button>
								<button
									type="button"
									onClick={() => onChange('')}
									className={`${imageBtnCls} hover:text-red-500`}
								>
									{IconTrash}
									{t('editor.relationField.removeImage')}
								</button>
							</>
						) : (
							sourceChoice
						)}
						{open && pickerModal}
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
						<ImageThumb key={currentUrl} url={currentUrl} className="h-full w-full object-cover" />
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

					{open && !disabled && (urlField ? pickerModal : pickerMenu)}
				</div>
			</div>

			{value && <p className="text-[10px] text-text-muted font-mono truncate">{value}</p>}

			{urlField &&
				!disabled &&
				canWrite &&
				uploadButton(
					t('editor.relationField.uploadImage'),
					'inline-flex items-center gap-1.5 px-2 py-1 bg-btn-secondary text-text rounded text-xs hover:bg-btn-secondary-hover',
				)}

			{creating && createDialog}
		</div>
	)
}
