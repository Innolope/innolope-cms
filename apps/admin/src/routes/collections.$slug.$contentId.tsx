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
}

function CollectionContentEditor() {
	const { slug, contentId } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const { getCollectionByName, refreshCollections } = useCollections()
	const collection = getCollectionByName(slug)
	const isNew = contentId === 'new'

	const [markdown, setMarkdown] = useState('')
	const [title, setTitle] = useState('')
	const [contentSlug, setContentSlug] = useState('')
	const [status, setStatus] = useState('draft')
	const [tags, setTags] = useState('')
	const [version, setVersion] = useState(1)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [loading, setLoading] = useState(!isNew)
	const license = useLicense()
	const aiLicensed = hasFeature(license, 'ai-assistant')
	const [showAi, setShowAi] = useState(false)
	const [aiTargetField, setAiTargetField] = useState<string | null>(null)
	const [aiSelectedText, setAiSelectedText] = useState<string | null>(null)
	const editorContainerRef = useRef<HTMLDivElement>(null)

	const reviewWorkflowsLicensed = hasFeature(license, 'review-workflows')

	useEffect(() => {
		if (!isNew && contentId) {
			api.get<ContentItem>(`/api/v1/content/${contentId}`)
				.then((item) => {
					setMarkdown(item.markdown)
					setTitle((item.metadata?.title as string) || '')
					setContentSlug(item.slug)
					setStatus(item.status)
					setTags(((item.metadata?.tags as string[]) || []).join(', '))
					setVersion(item.version)
				})
				.catch(() => navigate({ to: `/collections/${slug}` }))
				.finally(() => setLoading(false))
		}
	}, [contentId, isNew, navigate, slug])

	const generateSlug = (text: string) =>
		text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

	const save = async () => {
		if (!collection) return
		setSaving(true)
		try {
			const metadata = {
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
				</div>

				<MarkdownEditor
					content={markdown}
					onChange={(v) => { setMarkdown(v); setDirty(true) }}
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
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="flex-1 px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? 'Saving...' : 'Save'}
					</button>
					{!isNew && status === 'draft' && reviewWorkflowsLicensed && (
						<button type="button" onClick={submitForReview} disabled={saving} className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50">Submit</button>
					)}
					{!isNew && status === 'pending_review' && reviewWorkflowsLicensed && (
						<>
							<button type="button" onClick={approveContent} disabled={saving} className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50">Approve</button>
							<button type="button" onClick={rejectContent} disabled={saving} className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50">Reject</button>
						</>
					)}
					{!isNew && status !== 'published' && !reviewWorkflowsLicensed && (
						<button type="button" onClick={publish} disabled={saving} className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50">Publish</button>
					)}
				</div>

				<Field label="Title">
					<input
						type="text"
						value={title}
						onChange={(e) => { setTitle(e.target.value); setDirty(true); if (isNew) setContentSlug(generateSlug(e.target.value)) }}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
						placeholder="Enter title"
					/>
				</Field>

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

				<Field label="Tags">
					<input
						type="text"
						value={tags}
						onChange={(e) => { setTags(e.target.value); setDirty(true) }}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
						placeholder="tag1, tag2"
					/>
				</Field>

				<Field label="Collection">
					<p className="text-sm text-text-secondary">{collection?.label}</p>
				</Field>

				{!isNew && (
					<Field label="Version">
						<p className="text-sm text-text-secondary">v{version}</p>
					</Field>
				)}

				{!isNew && (
					<VersionPanel
						contentId={contentId}
						currentVersion={version}
						onRevert={() => {
							api.get<{ markdown: string; metadata: Record<string, unknown>; version: number }>(`/api/v1/content/${contentId}`)
								.then((item) => {
									setMarkdown(item.markdown)
									setTitle((item.metadata?.title as string) || '')
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
