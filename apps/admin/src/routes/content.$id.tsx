import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AiChatPanel } from '../components/ai/ai-chat-panel'
import { SelectionToolbar } from '../components/ai/selection-toolbar'
import { Dropdown } from '../components/dropdown'
import { MarkdownEditor } from '../components/editor/markdown-editor'
import { hasFeature, useLicense } from '../components/license-gate'
import { VersionPanel } from '../components/versions/version-panel'
import { api } from '../lib/api-client'
import { usePrompt } from '../lib/confirm'
import { useToast } from '../lib/toast'

export const Route = createFileRoute('/content/$id')({
	component: ContentEditor,
})

interface ContentItem {
	id: string
	slug: string
	status: string
	collectionId: string
	metadata: Record<string, unknown>
	markdown: string
	locale: string
	version: number
}

function ContentEditor() {
	const { t } = useTranslation()
	const { id } = Route.useParams()
	const navigate = useNavigate()
	const toast = useToast()
	const prompt = usePrompt()
	const isNew = id === 'new'

	const [markdown, setMarkdown] = useState('')
	const [title, setTitle] = useState('')
	const [slug, setSlug] = useState('')
	const [status, setStatus] = useState('draft')
	const [tags, setTags] = useState('')
	const [collectionId, setCollectionId] = useState('')
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

	// Warn about unsaved changes
	useEffect(() => {
		if (!dirty) return
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault()
		}
		window.addEventListener('beforeunload', handler)
		return () => window.removeEventListener('beforeunload', handler)
	}, [dirty])
	const [collections, setCollections] = useState<{ id: string; name: string }[]>([])

	const handleAiAction = (action: string, selectedText: string, fieldName: string) => {
		setAiTargetField(fieldName)
		setAiSelectedText(selectedText)
		setShowAi(true)
		if (action !== 'custom') {
			// Auto-trigger the action via the chat panel
			api
				.post<{ text: string; field: string }>('/api/v1/ai/complete', {
					field: fieldName,
					selectedText,
					action,
				})
				.then((_result) => {
					// Chat panel will show the result via its own state
				})
				.catch(() => {})
		}
	}

	const handleAiApply = (field: string, text: string) => {
		switch (field) {
			case 'title':
				setTitle(text)
				break
			case 'excerpt':
			case 'body':
				setMarkdown(text)
				break
			case 'slug':
				setSlug(text)
				break
			default:
				setMarkdown(text)
		}
		setDirty(true)
	}

	useEffect(() => {
		// Fetch collections for the dropdown
		api
			.get<{ id: string; name: string; slug: string }[]>('/api/v1/collections')
			.then(setCollections)
			.catch(() => {})
	}, [])

	useEffect(() => {
		if (!isNew) {
			api
				.get<ContentItem>(`/api/v1/content/${id}`)
				.then((item) => {
					setMarkdown(item.markdown)
					setTitle((item.metadata?.title as string) || '')
					setSlug(item.slug)
					setStatus(item.status)
					setCollectionId(item.collectionId)
					setVersion(item.version)
					setTags(
						Array.isArray(item.metadata?.tags) ? (item.metadata.tags as string[]).join(', ') : '',
					)
				})
				.catch(() => navigate({ to: '/dashboard' }))
				.finally(() => setLoading(false))
		}
	}, [id, isNew, navigate])

	const generateSlug = (text: string) => {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
	}

	const save = async () => {
		setSaving(true)
		try {
			const metadata: Record<string, unknown> = { title }
			if (tags.trim()) {
				metadata.tags = tags
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			}

			if (isNew) {
				const created = await api.post<ContentItem>('/api/v1/content', {
					slug: slug || generateSlug(title),
					collectionId,
					markdown,
					metadata,
					status,
				})
				setDirty(false)
				navigate({ to: '/content/$id', params: { id: created.id } })
			} else {
				await api.put(`/api/v1/content/${id}`, {
					slug,
					collectionId,
					markdown,
					metadata,
					status,
				})
				setDirty(false)
			}
		} catch (err) {
			toast(err instanceof Error ? err.message : t('content.errors.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const publish = async () => {
		const prevStatus = status
		setSaving(true)
		try {
			await api.put(`/api/v1/content/${id}`, { status: 'published' })
			setStatus('published')
		} catch (err) {
			setStatus(prevStatus)
			toast(err instanceof Error ? err.message : t('content.errors.publishFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const submitForReview = async () => {
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${id}/submit-for-review`, {})
			setStatus('pending_review')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('content.errors.submitFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const approveContent = async () => {
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${id}/approve`, {})
			setStatus('published')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('content.errors.approveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const rejectContent = async () => {
		const reason = await prompt({
			title: t('content.reject.title'),
			message: t('content.reject.message'),
			label: t('content.reject.reasonLabel'),
			placeholder: t('content.reject.reasonPlaceholder'),
			multiline: true,
			confirmLabel: t('content.reject.confirm'),
		})
		if (reason === null) return
		setSaving(true)
		try {
			await api.post(`/api/v1/content/${id}/reject`, { reason: reason || undefined })
			setStatus('draft')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('content.errors.rejectFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const reviewWorkflowsLicensed = hasFeature(license, 'review-workflows')

	if (loading) {
		return <div className="p-8 text-text-secondary text-sm">{t('common.loading')}</div>
	}

	return (
		<div className="flex h-full">
			{/* Editor area */}
			<div className="flex-1 overflow-auto p-8">
				<div className="max-w-3xl relative" ref={editorContainerRef}>
					{aiLicensed && (
						<SelectionToolbar
							containerRef={editorContainerRef}
							onAction={handleAiAction}
							fieldName="title"
						/>
					)}
					<input
						type="text"
						value={title}
						onChange={(e) => {
							setTitle(e.target.value)
							setDirty(true)
							if (isNew) setSlug(generateSlug(e.target.value))
						}}
						onFocus={() => setAiTargetField('title')}
						placeholder={t('content.titlePlaceholder')}
						className="w-full text-3xl font-bold bg-transparent border-none focus:outline-none mb-6 placeholder:text-text-faint"
					/>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: focus-tracking wrapper for the body editor, not an interactive control. */}
					<div className="relative" onFocus={() => setAiTargetField('body')}>
						{aiLicensed && (
							<SelectionToolbar
								containerRef={editorContainerRef}
								onAction={handleAiAction}
								fieldName="body"
							/>
						)}
						<MarkdownEditor
							content={markdown}
							onChange={(md) => {
								setMarkdown(md)
								setDirty(true)
							}}
							placeholder={t('content.bodyPlaceholder')}
						/>
					</div>
					{/* AI sparkle button */}
					{aiLicensed && !showAi && (
						<button
							type="button"
							onClick={() => {
								setShowAi(true)
								setAiTargetField('body')
							}}
							className="fixed bottom-6 right-6 w-10 h-10 bg-surface text-text rounded-full shadow-lg flex items-center justify-center hover:scale-110 transition-transform z-40 border border-border"
							title={t('content.openAiAssistant')}
						>
							<span className="text-lg">✨</span>
						</button>
					)}
				</div>
			</div>

			{/* Sidebar */}
			<div className="w-72 border-l border-border p-6 space-y-5 overflow-auto">
				<div className="flex gap-2">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="flex-1 px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? t('content.saving') : t('content.save')}
					</button>
					{!isNew && status === 'draft' && reviewWorkflowsLicensed && (
						<button
							type="button"
							onClick={submitForReview}
							disabled={saving}
							className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
						>
							{t('content.submit')}
						</button>
					)}
					{!isNew && status === 'pending_review' && reviewWorkflowsLicensed && (
						<>
							<button
								type="button"
								onClick={approveContent}
								disabled={saving}
								className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
							>
								{t('content.approve')}
							</button>
							<button
								type="button"
								onClick={rejectContent}
								disabled={saving}
								className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
							>
								{t('content.reject.button')}
							</button>
						</>
					)}
					{!isNew && status !== 'published' && !reviewWorkflowsLicensed && (
						<button
							type="button"
							onClick={publish}
							disabled={saving}
							className="px-4 py-2 bg-btn-secondary text-text rounded text-sm font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
						>
							{t('content.publish')}
						</button>
					)}
				</div>

				<Field label={t('content.fields.slug')}>
					<input
						type="text"
						value={slug}
						onChange={(e) => setSlug(e.target.value)}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong font-mono"
					/>
				</Field>

				<Field label={t('content.fields.status')}>
					<Dropdown
						value={status}
						onChange={setStatus}
						options={[
							{ value: 'draft', label: t('content.statusOptions.draft') },
							{ value: 'pending_review', label: t('content.statusOptions.pendingReview') },
							{ value: 'published', label: t('content.statusOptions.published') },
							{ value: 'archived', label: t('content.statusOptions.archived') },
						]}
						className="w-full"
					/>
				</Field>

				<Field label={t('content.fields.collection')}>
					<Dropdown
						value={collectionId}
						onChange={setCollectionId}
						options={[
							{ value: '', label: t('content.selectCollection') },
							...collections.map((c) => ({ value: c.id, label: c.name })),
						]}
						className="w-full"
					/>
				</Field>

				<Field label={t('content.fields.tags')}>
					<input
						type="text"
						value={tags}
						onChange={(e) => setTags(e.target.value)}
						placeholder={t('content.tagsPlaceholder')}
						className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
					/>
				</Field>

				{!isNew && (
					<div className="pt-4 border-t border-border">
						<VersionPanel
							contentId={id}
							currentVersion={version}
							onRevert={() => {
								// Reload content after revert
								api.get<ContentItem>(`/api/v1/content/${id}`).then((item) => {
									setMarkdown(item.markdown)
									setTitle((item.metadata?.title as string) || '')
									setVersion(item.version)
								})
							}}
						/>
						<p className="text-xs text-text-secondary mt-3">{t('content.id', { id })}</p>
					</div>
				)}
			</div>

			{/* AI Chat Panel */}
			{showAi && aiLicensed && (
				<div className="w-80 shrink-0">
					<AiChatPanel
						targetField={aiTargetField}
						selectedText={aiSelectedText}
						onApply={handleAiApply}
						onClose={() => setShowAi(false)}
					/>
				</div>
			)}
		</div>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: generic field wrapper — the control is passed in as children and rendered inside this label.
		<label className="block">
			<span className="block text-xs text-text-secondary mb-1.5">{label}</span>
			{children}
		</label>
	)
}
