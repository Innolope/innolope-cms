import { createFileRoute } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
	DeviceSwitch,
	PreviewFrame,
	type PreviewTemplateResponse,
	Spinner,
	useStoredDevice,
} from '../components/editor/article-preview-panel'
import { ExternalLinkIcon, EyeIcon } from '../components/icons'
import { api } from '../lib/api-client'
import { type PreviewLink, useArticlePreviewFeed } from '../lib/article-preview-channel'
import { useCollections } from '../lib/collections'

export const Route = createFileRoute('/collections/$slug/$contentId_/preview')({
	component: ArticlePreviewTab,
})

const TAB_DEVICE_KEY = 'innolope:article-preview:tab-device'

/**
 * A record's preview in a tab of its own: the article alone, full width, in the
 * collection's captured layout. The content comes from the editor over the preview
 * channel, so the tab follows unsaved edits and keeps following after the editor's
 * side panel is closed. With no editor open it shows the last version it received.
 */
function ArticlePreviewTab() {
	const { slug, contentId } = Route.useParams()
	const { t } = useTranslation()
	const { getCollectionByName, loading: collectionsLoading } = useCollections()
	const { feed, link, templateChange } = useArticlePreviewFeed(contentId)
	const collectionId = getCollectionByName(slug)?.id ?? feed?.collectionId ?? null
	// `undefined` while loading; `null` when the collection has no layout yet.
	const [template, setTemplate] = useState<PreviewTemplateResponse | null | undefined>(undefined)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [device, pickDevice] = useStoredDevice(TAB_DEVICE_KEY)
	const templateVersion =
		templateChange && templateChange.collectionId === collectionId ? templateChange.count : 0
	const editorHref = `/collections/${encodeURIComponent(slug)}/${encodeURIComponent(contentId)}`
	const title = feed?.content.title.trim() || t('editor.articlePreview.tab.untitled')

	// biome-ignore lint/correctness/useExhaustiveDependencies: `templateVersion` is the trigger to re-fetch after the layout changes in another tab; `t` only feeds the error fallback.
	useEffect(() => {
		if (!collectionId) return
		let cancelled = false
		api
			.get<{ template: PreviewTemplateResponse | null }>(
				`/api/v1/collections/${collectionId}/preview-template`,
			)
			.then((res) => {
				if (cancelled) return
				setTemplate(res.template)
				setLoadError(null)
			})
			.catch((err) => {
				if (!cancelled)
					setLoadError(err instanceof Error ? err.message : t('editor.articlePreview.loadFailed'))
			})
		return () => {
			cancelled = true
		}
	}, [collectionId, templateVersion])

	const hasFeed = !!feed
	useEffect(() => {
		document.title = hasFeed
			? t('editor.articlePreview.tab.documentTitle', { title })
			: t('editor.articlePreview.title')
	}, [hasFeed, title, t])

	const openEditor = (
		<a
			href={editorHref}
			target="_blank"
			rel="noopener"
			className="inline-flex items-center gap-2 mt-6 px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover"
		>
			{t('editor.articlePreview.tab.openEditor')}
			<ExternalLinkIcon className="w-3.5 h-3.5" />
		</a>
	)

	let main: ReactNode
	if (!collectionId)
		main = collectionsLoading ? (
			<Centered>
				<Spinner className="w-5 h-5" />
			</Centered>
		) : (
			<Centered>
				<p role="alert" className="text-sm text-danger text-center max-w-sm">
					{t('editor.articlePreview.tab.notFound')}
				</p>
			</Centered>
		)
	else if (loadError)
		main = (
			<Centered>
				<p role="alert" className="text-sm text-danger text-center max-w-sm">
					{loadError}
				</p>
			</Centered>
		)
	else if (template === undefined || (!feed && link === 'connecting'))
		main = (
			<Centered>
				<Spinner className="w-5 h-5" />
			</Centered>
		)
	else if (template === null)
		main = (
			<EmptyState
				heading={t('editor.articlePreview.tab.noTemplate.heading')}
				body={t('editor.articlePreview.tab.noTemplate.body')}
				action={openEditor}
			/>
		)
	else if (!feed)
		main = (
			<EmptyState
				heading={t('editor.articlePreview.tab.notConnected.heading')}
				body={t('editor.articlePreview.tab.notConnected.body')}
				action={openEditor}
			/>
		)
	else main = <PreviewFrame template={template} content={feed.content} device={device} />

	return (
		<div className="h-screen flex flex-col bg-bg">
			<header className="flex items-center gap-3 h-12 px-4 border-b border-border shrink-0">
				<EyeIcon className="w-4 h-4 text-text-muted shrink-0" />
				<h1 className="min-w-0 truncate text-sm font-medium text-text">
					{feed ? title : t('editor.articlePreview.title')}
				</h1>
				{/* With nothing to show, the empty state below already says no editor is open. */}
				{(feed || link === 'connecting') && <LinkStatus link={link} />}
				<span className="flex-1" />
				{template && feed && <DeviceSwitch value={device} onChange={pickDevice} />}
				{link === 'closed' && feed && (
					<a
						href={editorHref}
						target="_blank"
						rel="noopener"
						className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs text-text-secondary hover:text-text hover:bg-surface-alt transition-colors shrink-0"
					>
						{t('editor.articlePreview.tab.openEditor')}
						<ExternalLinkIcon className="w-3.5 h-3.5" />
					</a>
				)}
			</header>
			<main className="flex-1 min-h-0 flex flex-col">{main}</main>
		</div>
	)
}

/** Whether the tab is following an open editor, waiting for one, or showing a last version. */
function LinkStatus({ link }: { link: PreviewLink }) {
	const { t } = useTranslation()
	const status = {
		live: {
			dot: 'bg-success',
			label: t('editor.articlePreview.tab.live'),
			hint: t('editor.articlePreview.tab.liveHint'),
		},
		connecting: {
			dot: 'bg-text-muted animate-pulse',
			label: t('editor.articlePreview.tab.connecting'),
			hint: undefined,
		},
		closed: {
			dot: 'bg-warning',
			label: t('editor.articlePreview.tab.closed'),
			hint: t('editor.articlePreview.tab.closedHint'),
		},
	}[link]
	return (
		<span
			role="status"
			title={status.hint}
			className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-alt text-[11px] text-text-secondary whitespace-nowrap shrink-0"
		>
			<span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
			{status.label}
		</span>
	)
}

function Centered({ children }: { children: ReactNode }) {
	return (
		<div className="flex-1 flex items-center justify-center px-6 text-text-muted">{children}</div>
	)
}

function EmptyState({
	heading,
	body,
	action,
}: {
	heading: string
	body: string
	action: ReactNode
}) {
	return (
		<div className="flex-1 flex items-center justify-center px-6 py-12">
			<div className="w-full max-w-md text-center">
				<div className="mx-auto flex items-center justify-center w-10 h-10 mb-4 rounded-full bg-surface-alt text-text-secondary">
					<EyeIcon className="w-5 h-5" />
				</div>
				<h2 className="text-base font-semibold text-text">{heading}</h2>
				<p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{body}</p>
				{action}
			</div>
		</div>
	)
}
