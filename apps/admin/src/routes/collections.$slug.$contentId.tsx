import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/api-client'
import { useCollections } from '../lib/collections'
import { MarkdownEditor } from '../components/editor/markdown-editor'
import { VersionPanel } from '../components/versions/version-panel'
import { AiChatPanel } from '../components/ai/ai-chat-panel'
import { SelectionToolbar } from '../components/ai/selection-toolbar'
import { useLicense, hasFeature, UpgradePrompt } from '../components/license-gate'
import { useToast } from '../lib/toast'
import { Dropdown } from '../components/dropdown'

export const Route = createFileRoute('/collections/$slug/$contentId')({
	component: CollectionContentEditor,
})

interface ContentItem {
	id: string
	slug: string
	status: string
	metadata: Record<string, unknown>
	markdown: string
	locale: string
	version: number
	collectionId: string
	externalId?: string
}

/** Parse YAML frontmatter from markdown, return body + metadata */
function parseFrontmatter(md: string): { body: string; meta: Record<string, unknown> } {
	const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
	if (!match) return { body: md, meta: {} }

	const yamlBlock = match[1]
	const body = match[2]
	const meta: Record<string, unknown> = {}

	for (const line of yamlBlock.split('\n')) {
		const m = line.match(/^(\w[\w-]*):\s*(.*)$/)
		if (!m) continue
		const [, key, rawVal] = m
		let val: unknown = rawVal.trim()
		// Unquote strings
		if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
			val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
		}
		// Parse booleans
		if (val === 'true') val = true
		else if (val === 'false') val = false
		// Parse numbers
		else if (typeof val === 'string' && val && !Number.isNaN(Number(val))) val = Number(val)
		// Parse arrays
		else if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
			try { val = JSON.parse(val) } catch { /* keep as string */ }
		}
		meta[key] = val
	}

	return { body, meta }
}

function CollectionContentEditor() {
	const { slug, contentId } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const { getCollectionByName, refreshCollections } = useCollections()
	const collection = getCollectionByName(slug)
	const isNew = contentId === 'new'
	const isExternal = collection?.source === 'external'
	const isReadOnly = isExternal && collection?.accessMode === 'read-only'

	const [markdown, setMarkdown] = useState('')
	const [title, setTitle] = useState('')
	const [contentSlug, setContentSlug] = useState('')
	const [status, setStatus] = useState('draft')
	const [tags, setTags] = useState('')
	const [version, setVersion] = useState(1)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(!isNew)
	const [externalId, setExternalId] = useState<string | null>(null)
	const [extraFields, setExtraFields] = useState<Record<string, unknown>>({})
	const [showExtraFields, setShowExtraFields] = useState(false)
	const license = useLicense()
	const aiLicensed = hasFeature(license, 'ai-assistant')
	const [showAi, setShowAi] = useState(false)
	const [aiTargetField, setAiTargetField] = useState<string | null>(null)
	const [aiSelectedText, setAiSelectedText] = useState<string | null>(null)
	const editorContainerRef = useRef<HTMLDivElement>(null)

	const reviewWorkflowsLicensed = hasFeature(license, 'review-workflows')
	const [showDraftRestore, setShowDraftRestore] = useState(false)
	const draftKey = `innolope:draft:${contentId}`

	// Load content
	useEffect(() => {
		if (!isNew && contentId) {
			api.get<ContentItem>(`/api/v1/content/${contentId}`)
				.then((item) => {
					const { body, meta } = parseFrontmatter(item.markdown)
					const mergedMeta = { ...meta, ...item.metadata }

					setMarkdown(body.trim())
					setTitle((mergedMeta.title as string) || '')
					setContentSlug(item.slug)
					setStatus(item.status)
					setTags(((mergedMeta.tags as string[]) || []).join(', '))
					setVersion(item.version)
					setExternalId(item.externalId || null)

					// All metadata except title goes into extraFields (schema fields rendered dynamically for both internal and external)
					if (collection) {
						const extras: Record<string, unknown> = {}
						for (const [key, val] of Object.entries(mergedMeta)) {
							if (key !== 'title') extras[key] = val
						}
						setExtraFields(extras)
					}

					// Check for unsaved local draft
					try {
						const raw = localStorage.getItem(draftKey)
						if (raw) {
							const draft = JSON.parse(raw) as { markdown: string; title: string; savedAt: number }
							// Show restore prompt if draft is newer than content (within 24 hours)
							const ageMs = Date.now() - draft.savedAt
							if (ageMs < 24 * 60 * 60 * 1000 && (draft.markdown !== body.trim() || draft.title !== ((mergedMeta.title as string) || ''))) {
								setShowDraftRestore(true)
							} else {
								localStorage.removeItem(draftKey)
							}
						}
					} catch {}
				})
				.catch(() => navigate({ to: `/collections/${slug}` }))
				.finally(() => setLoading(false))
		}
	}, [contentId, isNew, navigate, slug, draftKey])

	// Auto-save draft to localStorage every 5 seconds when dirty
	useEffect(() => {
		if (!dirty || isNew) return
		const timer = setTimeout(() => {
			try {
				localStorage.setItem(draftKey, JSON.stringify({ markdown, title, savedAt: Date.now() }))
			} catch {}
		}, 5000)
		return () => clearTimeout(timer)
	}, [dirty, markdown, title, draftKey, isNew])

	const restoreDraft = () => {
		try {
			const raw = localStorage.getItem(draftKey)
			if (raw) {
				const draft = JSON.parse(raw) as { markdown: string; title: string }
				setMarkdown(draft.markdown)
				setTitle(draft.title)
				setDirty(true)
			}
		} catch {}
		setShowDraftRestore(false)
	}

	const dismissDraft = () => {
		localStorage.removeItem(draftKey)
		setShowDraftRestore(false)
	}

	const generateSlug = (text: string) =>
		text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

	const save = async () => {
		if (!collection) return
		if (isReadOnly) { toast('This collection is read-only', 'error'); return }
		setSaving(true)
		try {
			const metadata = {
				...extraFields,
				title,
				tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
			}
			if (isNew) {
				const created = await api.post<{ id: string }>('/api/v1/content', {
					slug: contentSlug || generateSlug(title),
					collectionId: collection.id,
					markdown,
					metadata,
					status,
				})
				refreshCollections()
				navigate({ to: `/collections/${slug}/${created.id}` })
			} else {
				await api.put(`/api/v1/content/${contentId}`, { slug: contentSlug, markdown, metadata, status })
			}
			setDirty(false)
			try { localStorage.removeItem(draftKey) } catch {}
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Save failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const publish = async () => {
		const prevStatus = status
		setSaving(true)
		try {
			await api.put(`/api/v1/content/${contentId}`, { status: 'published' })
			setStatus('published')
		} catch (err) {
			setStatus(prevStatus)
			toast(err instanceof Error ? err.message : 'Publish failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const submitForReview = async () => {
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${contentId}/submit-for-review`, {})
			setStatus('pending_review')
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Submit failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const approveContent = async () => {
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${contentId}/approve`, {})
			setStatus('published')
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Approve failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	const rejectContent = async () => {
		const reason = prompt('Rejection reason (optional):')
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${contentId}/reject`, { reason: reason || undefined })
			setStatus('draft')
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Reject failed', 'error')
		} finally {
			setSaving(false)
		}
	}

	if (loading) return <div className="p-8 pt-5" />

	return (
		<div className="flex h-full">
			<div className="flex-1 overflow-auto p-8" ref={editorContainerRef}>
				{/* Breadcrumb */}
				<div className="flex items-center gap-2 text-sm text-text-muted mb-4">
					<button type="button" onClick={() => navigate({ to: `/collections/${slug}` })} className="hover:text-text transition-colors">
						{collection?.label || slug}
					</button>
					<span>/</span>
					<span className="text-text">{isNew ? 'New' : title || contentSlug}</span>
					{isReadOnly && (
						<span className="ml-2 px-1.5 py-0.5 text-[10px] font-medium uppercase rounded bg-surface-alt text-text-muted">
							Read Only
						</span>
					)}
				</div>

				{/* Draft restore banner */}
				{showDraftRestore && (
					<div className="flex items-center justify-between px-4 py-2.5 mb-4 rounded-lg bg-surface-alt border border-border">
						<span className="text-sm text-text-secondary">You have unsaved changes from a previous session.</span>
						<div className="flex gap-2">
							<button type="button" onClick={restoreDraft} className="px-3 py-1 bg-btn-primary text-btn-primary-text rounded text-xs font-medium hover:bg-btn-primary-hover">Restore</button>
							<button type="button" onClick={dismissDraft} className="px-3 py-1 text-text-muted hover:text-text text-xs">Dismiss</button>
						</div>
					</div>
				)}

				{/* Title — above editor */}
				<input
					type="text"
					value={title}
					onChange={(e) => { setTitle(e.target.value); setDirty(true); if (isNew) setContentSlug(generateSlug(e.target.value)) }}
					placeholder="Enter title"
					disabled={isReadOnly}
					className="w-full text-3xl font-bold bg-transparent border-none outline-none mb-6 placeholder:text-text-muted disabled:opacity-60"
				/>

				{isReadOnly && (
					<div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-surface-alt text-xs text-text-muted">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
						This content is read-only. The external database connection is configured as read-only.
					</div>
				)}

				<MarkdownEditor
					content={markdown}
					onChange={(v) => { if (!isReadOnly) { setMarkdown(v); setDirty(true) } }}
				/>

				{editorContainerRef.current && aiSelectedText && (
					<SelectionToolbar
						containerRef={editorContainerRef as React.RefObject<HTMLElement>}
						onAction={(action: string, _selectedText: string, _fieldName: string) => { setAiTargetField('markdown'); setShowAi(true) }}
						fieldName="markdown"
					/>
				)}
			</div>

			{/* Sidebar */}
			<div className="w-72 border-l border-border p-6 space-y-4 overflow-auto shrink-0">
				<div className="flex gap-2">
					{!isReadOnly && (
						<button
							type="button"
							onClick={save}
							disabled={saving}
							className="flex-1 px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
						>
							{saving ? 'Saving...' : 'Save'}
						</button>
					)}
					{!isNew && !isReadOnly && status === 'draft' && reviewWorkflowsLicensed && (
						<button type="button" onClick={submitForReview} disabled={saving} className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50">Submit</button>
					)}
					{!isNew && !isReadOnly && status === 'pending_review' && reviewWorkflowsLicensed && (
						<>
							<button type="button" onClick={approveContent} disabled={saving} className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50">Approve</button>
							<button type="button" onClick={rejectContent} disabled={saving} className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50">Reject</button>
						</>
					)}
					{!isNew && !isReadOnly && status !== 'published' && !reviewWorkflowsLicensed && (
						<button type="button" onClick={publish} disabled={saving} className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50">Publish</button>
					)}
				</div>

				{/* For internal collections: slug + status */}
				{!isExternal && (
					<>
						<Field label="Slug">
							<input
								type="text"
								value={contentSlug}
								onChange={(e) => { setContentSlug(e.target.value); setDirty(true) }}
								className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong font-mono"
							/>
						</Field>

						<Field label="Status">
							<Dropdown
								value={status}
								onChange={(v) => { setStatus(v); setDirty(true) }}
								options={[
									{ value: 'draft', label: 'Draft' },
									{ value: 'pending_review', label: 'Pending Review' },
									{ value: 'published', label: 'Published' },
									{ value: 'archived', label: 'Archived' },
								]}
								className="w-full"
							/>
						</Field>
					</>
				)}

				{/* Dynamic schema fields (both internal and external) */}
				{collection?.fields
					?.filter(f => f.name !== 'title' && f.name !== 'content' && f.name !== 'body')
					.map(f => (
						<Field key={f.name} label={f.name}>
							{f.type === 'boolean' ? (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={!!(extraFields[f.name] ?? false)}
										onChange={(e) => { setExtraFields(prev => ({ ...prev, [f.name]: e.target.checked })); setDirty(true) }}
										disabled={isReadOnly}
										className="rounded"
									/>
									<span className="text-text-secondary">{extraFields[f.name] ? 'Yes' : 'No'}</span>
								</label>
							) : f.type === 'number' ? (
								<input
									type="number"
									value={String(extraFields[f.name] ?? '')}
									onChange={(e) => { setExtraFields(prev => ({ ...prev, [f.name]: e.target.value ? Number(e.target.value) : '' })); setDirty(true) }}
									disabled={isReadOnly}
									className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60"
								/>
							) : (
								<input
									type="text"
									value={String(extraFields[f.name] ?? '')}
									onChange={(e) => { setExtraFields(prev => ({ ...prev, [f.name]: e.target.value })); setDirty(true) }}
									disabled={isReadOnly}
									className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60"
								/>
							)}
						</Field>
					))
				}

				{/* Additional fields — fields in metadata not in the schema */}
				{(() => {
					const schemaNames = new Set(collection?.fields.map(f => f.name) ?? [])
					schemaNames.add('title')
					if (!isExternal) { schemaNames.add('tags') }
					const additionalEntries = Object.entries(extraFields).filter(([key]) => !schemaNames.has(key))
					if (additionalEntries.length === 0) return null
					return (
					<div>
						<button
							type="button"
							onClick={() => setShowExtraFields(!showExtraFields)}
							className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text transition-colors w-full"
						>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
								className={`transition-transform ${showExtraFields ? 'rotate-90' : ''}`}
							><polyline points="9 18 15 12 9 6" /></svg>
							Additional fields ({additionalEntries.length})
						</button>
						{showExtraFields && (
							<div className="mt-2 space-y-2">
								{additionalEntries.map(([key, val]) => (
									<div key={key}>
										<label className="block text-[10px] text-text-muted mb-0.5 font-mono">{key}</label>
										<input
											type="text"
											value={String(val ?? '')}
											onChange={(e) => {
												setExtraFields(prev => ({ ...prev, [key]: e.target.value }))
												setDirty(true)
											}}
											disabled={isReadOnly}
											className="w-full px-2 py-1.5 bg-input border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong disabled:opacity-60"
										/>
									</div>
								))}
								{!isReadOnly && (
									<button
										type="button"
										onClick={() => {
											const key = prompt('Field name:')
											if (key?.trim()) {
												setExtraFields(prev => ({ ...prev, [key.trim()]: '' }))
												setDirty(true)
												setShowExtraFields(true)
											}
										}}
										className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
									>
										+ Add field
									</button>
								)}
							</div>
						)}
					</div>
				)
				})()}

				{/* Add field button when no extra fields exist yet */}
				{Object.keys(extraFields).length === 0 && !isReadOnly && !isNew && (
					<button
						type="button"
						onClick={() => {
							const key = prompt('Field name:')
							if (key?.trim()) {
								setExtraFields(prev => ({ ...prev, [key.trim()]: '' }))
								setDirty(true)
								setShowExtraFields(true)
							}
						}}
						className="text-xs text-text-muted hover:text-text-secondary transition-colors"
					>
						+ Add custom field
					</button>
				)}

				<Field label="Collection">
					<p className="text-sm text-text-secondary">{collection?.label}</p>
				</Field>

				{!isNew && (
					<Field label="Version">
						<p className="text-sm text-text-secondary">v{version}</p>
					</Field>
				)}

				{externalId && (
					<Field label="External ID">
						<p className="text-xs text-text-muted font-mono break-all">{externalId}</p>
					</Field>
				)}

				{!isNew && !isExternal && (
					<VersionPanel
						contentId={contentId}
						currentVersion={version}
						onRevert={() => {
							api.get<{ markdown: string; metadata: Record<string, unknown>; version: number }>(`/api/v1/content/${contentId}`)
								.then((item) => {
									const { body, meta } = parseFrontmatter(item.markdown)
									setMarkdown(body.trim())
									setTitle((meta.title as string) || (item.metadata?.title as string) || '')
									setVersion(item.version)
									setDirty(false)
								})
						}}
					/>
				)}

				{aiLicensed ? (
					<button
						type="button"
						onClick={() => setShowAi(!showAi)}
						className="w-full px-3 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover transition-colors"
					>
						{showAi ? 'Hide AI' : 'AI Assistant'}
					</button>
				) : (
					<UpgradePrompt feature="AI Assistant" plan="Pro" />
				)}
			</div>

			{showAi && aiLicensed && (
				<AiChatPanel
					targetField={aiTargetField}
					selectedText={aiSelectedText}
					onApply={(_field: string, text: string) => { setMarkdown((prev) => `${prev}\n\n${text}`); setDirty(true) }}
					onClose={() => setShowAi(false)}
				/>
			)}
		</div>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<label className="block text-xs text-text-secondary mb-1.5">{label}</label>
			{children}
		</div>
	)
}
