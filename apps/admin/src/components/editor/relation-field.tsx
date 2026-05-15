import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../lib/api-client'
import { useCollections } from '../../lib/collections'
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
}

const URL_FIELD_PATTERN = /(^|_)(url|src|image|imageurl|photo|path|secure_url|file|thumbnail)($|_)/i

/** Pick the field in a related collection most likely to hold an image/file URL. */
function pickUrlField(fields: { name: string; type: string }[]): string | undefined {
	const textFields = fields.filter((f) => f.type === 'text' || f.type === 'string')
	return (textFields.find((f) => URL_FIELD_PATTERN.test(f.name)) || textFields[0])?.name
}

function docId(doc: RelatedDoc): string {
	return doc.externalId || doc.id
}

export function RelationField({ value, relationTo, disabled, onChange }: RelationFieldProps) {
	const toast = useToast()
	const { getCollectionByName } = useCollections()
	const related = relationTo ? getCollectionByName(relationTo) : undefined

	const [docs, setDocs] = useState<RelatedDoc[]>([])
	const [loading, setLoading] = useState(false)
	const [picking, setPicking] = useState(false)
	const [uploading, setUploading] = useState(false)

	const urlField = useMemo(() => (related ? pickUrlField(related.fields) : undefined), [related])

	const loadDocs = useCallback(() => {
		if (!related) return
		setLoading(true)
		api.get<{ data: RelatedDoc[] }>(`/api/v1/content?collectionId=${related.id}&limit=50`)
			.then((res) => setDocs(res.data || []))
			.catch(() => setDocs([]))
			.finally(() => setLoading(false))
	}, [related])

	useEffect(() => { loadDocs() }, [loadDocs])

	const current = docs.find((d) => docId(d) === value)
	const currentUrl = current && urlField ? String(current.metadata[urlField] || '') : ''

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
			toast(err instanceof Error ? err.message : 'Upload failed', 'error')
		} finally {
			setUploading(false)
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
						? `Related collection "${relationTo}" is not imported — showing the raw reference id.`
						: 'No related collection detected for this field.'}
				</p>
			</div>
		)
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				{currentUrl ? (
					<img src={currentUrl} alt="" className="h-14 w-14 rounded object-cover border border-border" />
				) : (
					<div className="h-14 w-14 rounded border border-dashed border-border flex items-center justify-center text-[10px] text-text-muted">
						{value ? 'ref' : 'empty'}
					</div>
				)}
				<div className="flex-1 min-w-0">
					{value && <p className="text-[10px] text-text-muted font-mono truncate">{value}</p>}
					{!disabled && (
						<div className="flex gap-2 mt-1">
							<button
								type="button"
								onClick={() => setPicking(true)}
								className="px-2 py-1 bg-btn-secondary text-text rounded text-xs hover:bg-btn-secondary-hover"
							>
								Select
							</button>
							<label className="px-2 py-1 bg-btn-secondary text-text rounded text-xs hover:bg-btn-secondary-hover cursor-pointer">
								{uploading ? 'Uploading…' : 'Upload'}
								<input
									type="file"
									accept="image/*"
									className="hidden"
									disabled={uploading || !urlField}
									onChange={(e) => {
										const file = e.target.files?.[0]
										if (file) handleUpload(file)
										e.target.value = ''
									}}
								/>
							</label>
							{value && (
								<button
									type="button"
									onClick={() => onChange('')}
									className="px-2 py-1 text-text-muted hover:text-text text-xs"
								>
									Clear
								</button>
							)}
						</div>
					)}
				</div>
			</div>

			{picking && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPicking(false)}>
					<div
						className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between px-5 py-4 border-b border-border">
							<h3 className="text-sm font-semibold">Select {related.label}</h3>
							<button type="button" onClick={() => setPicking(false)} className="text-text-secondary hover:text-text text-xs">
								Close
							</button>
						</div>
						<div className="flex-1 overflow-auto p-4">
							{loading ? (
								<p className="text-sm text-text-muted">Loading…</p>
							) : docs.length === 0 ? (
								<p className="text-sm text-text-muted">No records found.</p>
							) : (
								<div className="grid grid-cols-3 gap-2">
									{docs.map((doc) => {
										const id = docId(doc)
										const url = urlField ? String(doc.metadata[urlField] || '') : ''
										return (
											<button
												key={id}
												type="button"
												onClick={() => { onChange(id); setPicking(false) }}
												className={`rounded border overflow-hidden text-left ${id === value ? 'border-border-strong' : 'border-border'} hover:border-border-strong`}
											>
												{url ? (
													<img src={url} alt="" className="h-20 w-full object-cover" />
												) : (
													<div className="h-20 flex items-center justify-center text-[10px] text-text-muted">no preview</div>
												)}
												<p className="px-1.5 py-1 text-[10px] text-text-muted font-mono truncate">{id}</p>
											</button>
										)
									})}
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	)
}
