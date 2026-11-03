import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, api } from '../../lib/api-client'
import {
	buildPreviewDocument,
	fillPreviewSlots,
	type PreviewContent,
} from '../../lib/article-preview'
import { announceTemplateChange, useArticlePreviewHost } from '../../lib/article-preview-channel'
import { useCollections } from '../../lib/collections'
import { useConfirm } from '../../lib/confirm'
import { relativeTime } from '../../lib/relative-time'
import { useToast } from '../../lib/toast'
import { CloseIcon, ExternalLinkIcon, EyeIcon, MonitorIcon, PhoneIcon, TabletIcon } from '../icons'
import { KebabMenu } from '../kebab-menu'
import { pickUrlField } from './relation-field'

/** One detected region of the captured page, as the API reports it. */
export interface PreviewSlotInfo {
	selector: string
	strategy: 'override' | 'record-match' | 'semantic' | 'heuristic'
	sample?: string
}

/** CSS selectors an admin can set when automatic detection picks the wrong element. */
export interface PreviewSelectors {
	title?: string
	body?: string
	image?: string
}

/** A collection's captured article template (`GET /collections/:id/preview-template`). */
export interface PreviewTemplateResponse {
	collectionId: string
	sourceUrl: string
	finalUrl: string
	html: string
	slots: { title: PreviewSlotInfo | null; body: PreviewSlotInfo; image: PreviewSlotInfo | null }
	classMap: Record<string, string>
	selectors: PreviewSelectors | null
	warnings: string[]
	stats: { bytes: number; stylesheets: number; inlinedFonts: number }
	capturedAt: string
}

export type Device = 'desktop' | 'tablet' | 'mobile'

const ALL_DEVICES: readonly Device[] = ['desktop', 'tablet', 'mobile']
/** The record page's preview offers the two layouts a site is designed for. */
const MODAL_DEVICES: readonly Device[] = ['desktop', 'mobile']

/**
 * Viewport each device renders at. Desktop never goes below 1280 so a narrow pane
 * shows the real desktop layout scaled down rather than the site's tablet layout.
 */
const DEVICE_WIDTH: Record<Device, number> = { desktop: 1280, tablet: 820, mobile: 390 }
/** A tablet or phone outline is no taller than the screen it stands for. */
const DEVICE_HEIGHT: Partial<Record<Device, number>> = { tablet: 1180, mobile: 844 }
const DEVICE_KEY = 'innolope:article-preview:device'

/** How long typing settles before the preview catches up. */
const FILL_DEBOUNCE_MS = 200

const SLOT_KEYS = ['title', 'body', 'image'] as const

function readDevice(key: string, allowed: readonly Device[]): Device {
	try {
		const stored = localStorage.getItem(key)
		const match = allowed.find((d) => d === stored)
		if (match) return match
	} catch {}
	return allowed[0]
}

/** The device the preview renders at, remembered per place it's shown (record page, tab). */
export function useStoredDevice(
	key: string,
	allowed: readonly Device[] = ALL_DEVICES,
): [Device, (next: Device) => void] {
	const [device, setDevice] = useState<Device>(() => readDevice(key, allowed))
	const pick = (next: Device) => {
		setDevice(next)
		try {
			localStorage.setItem(key, next)
		} catch {}
	}
	return [device, pick]
}

/** `blog.example.com/posts/hello` — the part of a URL worth showing in a chip. */
function shortUrl(url: string): string {
	try {
		const u = new URL(url)
		return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
	} catch {
		return url
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

/** Drop blank selectors so an emptied input means "detect automatically" again. */
function cleanSelectors(selectors: PreviewSelectors): PreviewSelectors | undefined {
	const out: PreviewSelectors = {}
	for (const key of SLOT_KEYS) {
		const value = selectors[key]?.trim()
		if (value) out[key] = value
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/**
 * A value that is already an image URL: a string URL/path, or an object carrying
 * one (`{ url }`, `{ src }`). A bare id is not — it names a media record.
 */
function directImageUrl(value: unknown): string | null {
	if (typeof value === 'string') {
		const v = value.trim()
		return /^(https?:)?\/\//i.test(v) || v.startsWith('/') || v.startsWith('data:image/')
			? absoluteMediaUrl(v)
			: null
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>
		for (const key of ['url', 'src', 'secure_url', 'imageUrl']) {
			const url = directImageUrl(obj[key])
			if (url) return url
		}
		// A localized value (`{ en: 'https://…' }`).
		for (const v of Object.values(obj)) {
			if (typeof v === 'string') return directImageUrl(v)
		}
	}
	return null
}

/**
 * Root-relative media (`/uploads/…`) is served by the CMS, but inside the preview
 * it would resolve against the captured site's `<base>`. Pin it to this origin.
 */
function absoluteMediaUrl(url: string): string {
	return url.startsWith('/') && !url.startsWith('//')
		? new URL(url, window.location.origin).toString()
		: url
}

/** The same rewrite for media the markdown body links to. */
function absolutizeMarkdownMedia(markdown: string): string {
	return markdown.replace(/(\]\(|src=["'])(\/uploads\/)/g, (_m, lead: string, path: string) => {
		return `${lead}${window.location.origin}${path}`
	})
}

/** A record's cover-image field: its raw value and, for relations, the media collection. */
export interface PreviewImageRef {
	value: unknown
	relationTo?: string | null
}

/**
 * Resolve the cover field to a URL. URLs pass straight through; a relation id is
 * looked up in the related collection and read from its file column — the same
 * column the sidebar's image preview reads. The lookup waits until a preview is shown.
 */
function useImageUrl(image: PreviewImageRef | null | undefined, enabled: boolean): string | null {
	const { getCollectionByName } = useCollections()
	const direct = directImageUrl(image?.value)
	const related = image?.relationTo ? getCollectionByName(image.relationTo) : undefined
	const id =
		!direct && typeof image?.value === 'string' && image.value.trim() ? image.value.trim() : null
	const [resolved, setResolved] = useState<{ id: string; url: string | null } | null>(null)

	useEffect(() => {
		if (!enabled || !id || !related) return
		const urlField = pickUrlField(related)
		if (!urlField) return
		let cancelled = false
		api
			.get<{ metadata?: Record<string, unknown> }>(
				`/api/v1/content/${encodeURIComponent(id)}?collectionId=${related.id}`,
			)
			.then((doc) => {
				if (!cancelled) setResolved({ id, url: directImageUrl(doc.metadata?.[urlField]) })
			})
			.catch(() => {
				if (!cancelled) setResolved({ id, url: null })
			})
		return () => {
			cancelled = true
		}
	}, [enabled, id, related])

	return direct ?? (resolved && resolved.id === id ? resolved.url : null)
}

/**
 * The record's content as the preview shows it, for the side panel and for a
 * preview open in another tab: media URLs pinned to the CMS and the cover resolved.
 * While a tab for this record is open it also receives every edit.
 */
function useArticlePreview({
	recordId,
	collectionId,
	content: base,
	image,
	panelOpen,
}: {
	/** Saved records only: a new record's id changes when it's first saved. */
	recordId: string | null
	collectionId: string | null
	content: Omit<PreviewContent, 'imageUrl'>
	image?: PreviewImageRef | null
	panelOpen: boolean
}): PreviewContent {
	const host = useArticlePreviewHost(recordId && collectionId ? recordId : null)
	const imageUrl = useImageUrl(image, panelOpen || host.listening)
	const content: PreviewContent = {
		...base,
		markdown: absolutizeMarkdownMedia(base.markdown),
		imageUrl,
	}
	const { publish } = host
	// biome-ignore lint/correctness/useExhaustiveDependencies: the fields are the triggers; the object is rebuilt on every render.
	useEffect(() => {
		if (collectionId) publish({ collectionId, content })
	}, [
		collectionId,
		content.title,
		content.markdown,
		content.imageUrl,
		content.imageAlt,
		content.locale,
		publish,
	])
	return content
}

/**
 * The record page's preview: the full-window modal while it's open, and — open or
 * not — the editor's end of a preview showing in another tab.
 */
export function ArticlePreview({
	recordId,
	content,
	image,
	open,
	...modal
}: Omit<ArticlePreviewModalProps, 'content'> & {
	recordId: string | null
	content: Omit<PreviewContent, 'imageUrl'>
	image?: PreviewImageRef | null
	open: boolean
}) {
	const resolved = useArticlePreview({
		recordId,
		collectionId: modal.collectionId,
		content,
		image,
		panelOpen: open,
	})
	return open ? <ArticlePreviewModal {...modal} content={resolved} /> : null
}

/**
 * Templates already loaded on this page, by collection (`null`: none captured), so
 * reopening the preview shows the layout at once. Each open still re-checks the API.
 */
const templateCache = new Map<string, PreviewTemplateResponse | null>()

/** Test hook: start from an empty cache. */
export function clearPreviewTemplateCache() {
	templateCache.clear()
}

/** The same capture: keeping the old object stops the frame reloading for nothing. */
function sameTemplate(a: PreviewTemplateResponse | null, b: PreviewTemplateResponse | null) {
	return (
		a === b || (!!a && !!b && a.collectionId === b.collectionId && a.capturedAt === b.capturedAt)
	)
}

const FOCUSABLE =
	'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => !el.closest('[inert],[hidden]'),
	)
}

/**
 * Keyboard behaviour of a modal: focus moves in on open and back to the opener on
 * close, Tab stays inside, and Esc calls `onEscape`. A confirm opened from inside
 * (removing the layout) renders later in the document and owns the keys while it's up;
 * a handler that already took Esc (an open menu) marks it with `preventDefault`.
 */
function useModalKeys(ref: React.RefObject<HTMLElement | null>, onEscape: () => void): () => void {
	const escapeRef = useRef(onEscape)
	escapeRef.current = onEscape

	useEffect(() => {
		const dialog = ref.current
		if (!dialog) return
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
		dialog.focus({ preventScroll: true })

		const onTop = () => isTopDialog(dialog)
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented || !onTop()) return
			if (e.key === 'Escape') {
				e.preventDefault()
				escapeRef.current()
			} else if (e.key === 'Tab') {
				const items = focusables(dialog)
				const first = items[0]
				const last = items[items.length - 1]
				const active = document.activeElement
				if (!first || !last) {
					e.preventDefault()
				} else if (e.shiftKey && (active === first || active === dialog)) {
					e.preventDefault()
					last.focus()
				} else if (!e.shiftKey && active === last) {
					e.preventDefault()
					first.focus()
				}
			}
		}
		// Tabbing out of the frame's document lands in the parent page, past the trap
		// above; pull focus back in.
		const onFocusIn = (e: FocusEvent) => {
			if (!onTop() || !(e.target instanceof Node) || dialog.contains(e.target)) return
			;(focusables(dialog)[0] ?? dialog).focus()
		}
		document.addEventListener('keydown', onKeyDown)
		document.addEventListener('focusin', onFocusIn)
		return () => {
			document.removeEventListener('keydown', onKeyDown)
			document.removeEventListener('focusin', onFocusIn)
			if (opener?.isConnected) opener.focus({ preventScroll: true })
		}
	}, [ref])

	// Keys typed inside the preview frame stay in its document; it forwards Esc here.
	return () => {
		if (ref.current && isTopDialog(ref.current)) escapeRef.current()
	}
}

/** Whether `dialog` is the last modal in the document, i.e. the one the user sees on top. */
function isTopDialog(dialog: HTMLElement): boolean {
	const open = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
	return open[open.length - 1] === dialog
}

export function Spinner({ className = 'w-3.5 h-3.5' }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={`${className} inline-block border-2 border-current border-t-transparent rounded-full animate-spin`}
		/>
	)
}

interface CaptureError {
	code?: string
	message: string
}

interface ArticlePreviewModalProps {
	collectionId: string
	/** Admins and owners can capture, change and remove the collection's template. */
	canConfigure: boolean
	/** The record as it stands in the editor, unsaved edits included (`useArticlePreview`). */
	content: PreviewContent
	/** A likely article URL (this record's public URL), offered as a one-click fill. */
	suggestedUrl?: string | null
	/** Where this record's preview opens as its own tab; absent for unsaved records. */
	tabHref?: string | null
	onClose: () => void
}

/**
 * Shows the record inside its own site's article layout, over the whole window. The
 * layout is captured once per collection from a published article (the API keeps a
 * sanitized copy with the title, body and cover marked as slots); this modal renders
 * that copy in a frame and pours the editor's current content into the slots.
 */
export function ArticlePreviewModal({
	collectionId,
	canConfigure,
	content,
	suggestedUrl,
	tabHref,
	onClose,
}: ArticlePreviewModalProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [template, setTemplate] = useState<PreviewTemplateResponse | null>(
		() => templateCache.get(collectionId) ?? null,
	)
	const [loading, setLoading] = useState(() => !templateCache.has(collectionId))
	const [loadError, setLoadError] = useState<string | null>(null)
	// The URL form shown over an existing preview ("Use a different article", "Detection settings").
	const [changing, setChanging] = useState<null | 'url' | 'selectors'>(null)
	const [capturing, setCapturing] = useState(false)
	const [captureError, setCaptureError] = useState<CaptureError | null>(null)
	const [device, pickDevice] = useStoredDevice(DEVICE_KEY, MODAL_DEVICES)
	const [showNotes, setShowNotes] = useState(false)
	const dialogRef = useRef<HTMLDivElement>(null)
	// Esc backs out of the change-layout form first, then closes the preview.
	const frameEscape = useModalKeys(dialogRef, () => {
		if (changing && !capturing) setChanging(null)
		else onClose()
	})

	// biome-ignore lint/correctness/useExhaustiveDependencies: `t` only feeds the error fallback; re-fetching when its identity changes would flash the loading state for nothing.
	useEffect(() => {
		let cancelled = false
		const cached = templateCache.has(collectionId)
		setLoading(!cached)
		setLoadError(null)
		api
			.get<{ template: PreviewTemplateResponse | null }>(
				`/api/v1/collections/${collectionId}/preview-template`,
			)
			.then((res) => {
				templateCache.set(collectionId, res.template)
				if (!cancelled)
					setTemplate((prev) => (sameTemplate(prev, res.template) ? prev : res.template))
			})
			.catch((err) => {
				// A failed re-check keeps showing the layout already on screen.
				if (!cancelled && !cached)
					setLoadError(err instanceof Error ? err.message : t('editor.articlePreview.loadFailed'))
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [collectionId])

	const capture = async (url: string, selectors: PreviewSelectors, fromMenu = false) => {
		setCapturing(true)
		setCaptureError(null)
		try {
			const res = await api.post<{ template: PreviewTemplateResponse }>(
				`/api/v1/collections/${collectionId}/preview-template`,
				{ url: url.trim(), selectors: cleanSelectors(selectors) },
			)
			// Cached first: the copy finishes on the server even if the preview was closed meanwhile.
			templateCache.set(collectionId, res.template)
			setTemplate(res.template)
			setChanging(null)
			setShowNotes(false)
			announceTemplateChange(collectionId)
		} catch (err) {
			const failure = {
				code: err instanceof ApiError ? err.code : undefined,
				message: err instanceof Error ? err.message : t('editor.articlePreview.errors.generic'),
			}
			setCaptureError(failure)
			// A re-copy from the menu has no form on screen to carry the error.
			if (fromMenu)
				toast(
					t(`editor.articlePreview.errors.${failure.code ?? 'generic'}`, {
						defaultValue: failure.message,
					}),
					'error',
				)
		} finally {
			setCapturing(false)
		}
	}

	const remove = async () => {
		const ok = await confirm({
			title: t('editor.articlePreview.remove.title'),
			message: t('editor.articlePreview.remove.message'),
			confirmLabel: t('editor.articlePreview.remove.confirm'),
			danger: true,
		})
		if (!ok) return
		try {
			await api.delete(`/api/v1/collections/${collectionId}/preview-template`)
			templateCache.set(collectionId, null)
			setTemplate(null)
			setChanging(null)
			announceTemplateChange(collectionId)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('editor.articlePreview.errors.generic'), 'error')
		}
	}

	const openChange = (mode: 'url' | 'selectors') => {
		setCaptureError(null)
		setChanging(mode)
	}

	const menuItems = template
		? [
				{
					label: t('editor.articlePreview.menu.recapture'),
					onClick: () => capture(template.sourceUrl, template.selectors ?? {}, true),
					disabled: capturing,
				},
				{
					label: t('editor.articlePreview.menu.changeArticle'),
					onClick: () => openChange('url'),
				},
				{
					label: t('editor.articlePreview.menu.detection'),
					onClick: () => openChange('selectors'),
				},
				{ label: t('editor.articlePreview.menu.remove'), onClick: remove, danger: true },
			]
		: []

	return (
		<div className="fixed inset-0 z-50 flex sm:p-6 bg-black/60">
			{/* Clicking the dimmed margin closes; it isn't a tab stop, Esc and the × button are. */}
			<button
				type="button"
				tabIndex={-1}
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 cursor-default"
				onClick={onClose}
			/>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={t('editor.articlePreview.title')}
				tabIndex={-1}
				className="relative flex-1 min-w-0 flex flex-col bg-bg sm:border sm:border-border sm:rounded-xl shadow-2xl overflow-hidden outline-none motion-safe:animate-[slideIn_0.18s_ease-out]"
			>
				{/* Three columns so the device switch sits in the middle whatever the sides hold. */}
				<header className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 h-14 px-3 border-b border-border shrink-0">
					<div className="flex items-center gap-2 min-w-0">
						<EyeIcon className="hidden sm:block w-4 h-4 ml-1 text-text-muted shrink-0" />
						<span className="text-sm font-medium text-text shrink-0">
							{t('editor.articlePreview.title')}
						</span>
						{template && (
							<a
								href={template.finalUrl}
								target="_blank"
								rel="noopener noreferrer"
								title={t('editor.articlePreview.openSource')}
								className="hidden md:inline-flex items-center min-w-0 px-2 py-1 rounded bg-surface-alt text-[11px] text-text-secondary hover:text-text transition-colors"
							>
								<span className="truncate">{shortUrl(template.finalUrl)}</span>
							</a>
						)}
					</div>
					<div className="flex justify-center">
						{template && (
							<DeviceSwitch value={device} onChange={pickDevice} devices={MODAL_DEVICES} labelled />
						)}
					</div>
					<div className="flex items-center justify-end gap-1 min-w-0">
						{capturing && template && (
							<span className="hidden lg:inline-flex items-center gap-1.5 mr-1 text-[11px] text-text-muted shrink-0">
								<Spinner className="w-3 h-3" />
								{t('editor.articlePreview.recapturing')}
							</span>
						)}
						{template && tabHref && (
							// A plain link, not window.open: popup blockers never stop a click on one.
							<a
								href={tabHref}
								target="_blank"
								rel="noopener"
								aria-label={t('editor.articlePreview.openInTab')}
								title={t('editor.articlePreview.openInTab')}
								className="flex items-center justify-center w-8 h-8 rounded text-text-muted hover:text-text hover:bg-surface-alt transition-colors shrink-0"
							>
								<ExternalLinkIcon className="w-4 h-4" />
							</a>
						)}
						{template && canConfigure && (
							<KebabMenu items={menuItems} label={t('editor.articlePreview.menu.label')} />
						)}
						<button
							type="button"
							onClick={onClose}
							aria-label={t('editor.articlePreview.close')}
							title={t('editor.articlePreview.closeHint')}
							className="flex items-center justify-center w-8 h-8 rounded text-text-muted hover:text-text hover:bg-surface-alt transition-colors shrink-0"
						>
							<CloseIcon className="w-4 h-4" />
						</button>
					</div>
				</header>

				{loading ? (
					<div className="flex-1 flex items-center justify-center text-text-muted">
						<Spinner className="w-5 h-5" />
					</div>
				) : loadError ? (
					<div className="flex-1 flex items-center justify-center px-6">
						<p role="alert" className="text-sm text-danger text-center max-w-sm">
							{loadError}
						</p>
					</div>
				) : !template ? (
					<TemplateSetup
						key="first"
						canConfigure={canConfigure}
						suggestedUrl={suggestedUrl}
						capturing={capturing}
						error={captureError}
						onSubmit={capture}
					/>
				) : (
					<>
						<div className="relative flex-1 min-h-0 flex flex-col">
							<PreviewFrame
								template={template}
								content={content}
								device={device}
								onEscape={frameEscape}
							/>
							{changing && (
								<div className="absolute inset-0 z-10 flex flex-col bg-bg/95 backdrop-blur-sm">
									<TemplateSetup
										key={changing}
										canConfigure={canConfigure}
										initialUrl={template.sourceUrl}
										initialSelectors={template.selectors ?? {}}
										detected={template.slots}
										openSelectors={changing === 'selectors'}
										capturing={capturing}
										error={captureError}
										onSubmit={capture}
										onCancel={() => setChanging(null)}
									/>
								</div>
							)}
						</div>
						<PreviewFooter
							template={template}
							showNotes={showNotes}
							onToggleNotes={() => setShowNotes((v) => !v)}
						/>
					</>
				)}
			</div>
		</div>
	)
}

const DEVICE_ICON: Record<Device, (props: { className?: string }) => React.ReactNode> = {
	desktop: MonitorIcon,
	tablet: TabletIcon,
	mobile: PhoneIcon,
}

/**
 * The preview width as a segmented control. It's a radio group: one tab stop, and
 * the arrow keys move between the options.
 */
export function DeviceSwitch({
	value,
	onChange,
	devices = ALL_DEVICES,
	labelled = false,
}: {
	value: Device
	onChange: (d: Device) => void
	devices?: readonly Device[]
	/** Name each option next to its icon, not only in a tooltip. */
	labelled?: boolean
}) {
	const { t } = useTranslation()
	const buttons = useRef<(HTMLButtonElement | null)[]>([])
	const current = Math.max(0, devices.indexOf(value))

	const onKeyDown = (e: React.KeyboardEvent, index: number) => {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
		if (!step) return
		e.preventDefault()
		const next = (index + step + devices.length) % devices.length
		onChange(devices[next])
		buttons.current[next]?.focus()
	}

	return (
		<div
			role="radiogroup"
			aria-label={t('editor.articlePreview.device.label')}
			className="inline-flex items-center p-0.5 rounded-lg bg-surface-alt shrink-0"
		>
			{devices.map((device, index) => {
				const active = value === device
				const label = t(`editor.articlePreview.device.${device}`)
				const Icon = DEVICE_ICON[device]
				return (
					// biome-ignore lint/a11y/useSemanticElements: a segmented control of icon buttons; native radios can't be styled as icon pills without hiding them.
					<button
						key={device}
						ref={(el) => {
							buttons.current[index] = el
						}}
						type="button"
						role="radio"
						aria-checked={active}
						aria-label={label}
						title={label}
						tabIndex={index === current ? 0 : -1}
						onClick={() => onChange(device)}
						onKeyDown={(e) => onKeyDown(e, index)}
						className={`flex items-center justify-center rounded-md transition-colors ${
							labelled ? 'gap-1.5 h-7 px-2.5 sm:px-3 text-xs font-medium' : 'w-7 h-6'
						} ${active ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'}`}
					>
						<Icon className="w-3.5 h-3.5" />
						{labelled && (
							<span aria-hidden="true" className="hidden sm:inline">
								{label}
							</span>
						)}
					</button>
				)
			})}
		</div>
	)
}

/**
 * The captured page in a sandboxed frame. `allow-same-origin` without
 * `allow-scripts` lets the editor reach into the document to refill the slots in
 * place (no reload per keystroke, so the CSS stays loaded and the scroll position
 * holds) while nothing inside the frame can run. The document also carries its own
 * CSP from `buildPreviewDocument`.
 */
export function PreviewFrame({
	template,
	content,
	device,
	onEscape,
}: {
	template: PreviewTemplateResponse
	content: PreviewContent
	device: Device
	/** Esc pressed while the frame has focus, which keeps the key from the page. */
	onEscape?: () => void
}) {
	const { t } = useTranslation()
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const stageRef = useRef<HTMLDivElement>(null)
	const contentRef = useRef(content)
	contentRef.current = content
	const escapeRef = useRef(onEscape)
	escapeRef.current = onEscape
	const [loaded, setLoaded] = useState(false)
	const [stage, setStage] = useState({ width: 0, height: 0 })

	// Built once per template. Later edits patch the live document instead, so the
	// srcdoc (and the frame) only reloads when the template itself changes.
	const srcDoc = useMemo(() => buildPreviewDocument(template, contentRef.current), [template])

	// biome-ignore lint/correctness/useExhaustiveDependencies: `srcDoc` is the trigger — a new document starts unloaded.
	useEffect(() => {
		setLoaded(false)
	}, [srcDoc])

	useEffect(() => {
		const el = stageRef.current
		if (!el) return
		const observer = new ResizeObserver(([entry]) => {
			setStage({ width: entry.contentRect.width, height: entry.contentRect.height })
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// Keyed on the content's fields rather than the object, which the editor rebuilds
	// on every render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the fields are the triggers; the fill reads the latest content from the ref.
	useEffect(() => {
		if (!loaded) return
		const id = window.setTimeout(() => {
			const doc = iframeRef.current?.contentDocument
			if (doc) fillPreviewSlots(doc, template.classMap, contentRef.current)
		}, FILL_DEBOUNCE_MS)
		return () => window.clearTimeout(id)
	}, [
		content.title,
		content.markdown,
		content.imageUrl,
		content.imageAlt,
		content.locale,
		loaded,
		template,
	])

	// Tablet and phone sit in a device outline with breathing room around it, centred
	// when the screen is taller than the device; desktop fills the pane edge to edge.
	const framed = device !== 'desktop'
	const gutter = framed ? 48 : 0
	const available = Math.max(0, stage.width - gutter)
	const deviceWidth =
		device === 'desktop' ? Math.max(DEVICE_WIDTH.desktop, available) : DEVICE_WIDTH[device]
	const scale = available > 0 ? Math.min(1, available / deviceWidth) : 1
	const deviceHeight = DEVICE_HEIGHT[device]
	const frameHeight = Math.max(
		0,
		Math.min(stage.height - gutter, deviceHeight ? deviceHeight * scale : Number.POSITIVE_INFINITY),
	)
	const frameTop = framed ? Math.max(gutter / 2, (stage.height - frameHeight) / 2) : 0

	return (
		<div ref={stageRef} className="relative flex-1 min-h-0 overflow-hidden bg-surface-alt">
			{stage.width > 0 && (
				<div
					className={`absolute left-1/2 -translate-x-1/2 overflow-hidden bg-white ${
						framed ? 'rounded-2xl ring-1 ring-border-strong shadow-lg' : ''
					}`}
					style={{ top: frameTop, width: deviceWidth * scale, height: frameHeight }}
				>
					<iframe
						ref={iframeRef}
						title={t('editor.articlePreview.frameTitle')}
						srcDoc={srcDoc}
						sandbox="allow-same-origin"
						referrerPolicy="no-referrer"
						onLoad={() => {
							const doc = iframeRef.current?.contentDocument
							if (doc) {
								fillPreviewSlots(doc, template.classMap, contentRef.current)
								// Each load is a new document, so this never stacks up.
								doc.addEventListener('keydown', (e) => {
									if (e.key === 'Escape') escapeRef.current?.()
								})
							}
							setLoaded(true)
						}}
						className="block border-0 origin-top-left"
						style={{
							width: deviceWidth,
							height: frameHeight / scale,
							transform: `scale(${scale})`,
						}}
					/>
				</div>
			)}
			{!loaded && (
				<div className="absolute inset-0 flex items-center justify-center text-text-muted">
					<Spinner className="w-5 h-5" />
				</div>
			)}
		</div>
	)
}

function PreviewFooter({
	template,
	showNotes,
	onToggleNotes,
}: {
	template: PreviewTemplateResponse
	showNotes: boolean
	onToggleNotes: () => void
}) {
	const { t } = useTranslation()
	const found = SLOT_KEYS.filter((k) => template.slots[k])
	return (
		<footer className="shrink-0 border-t border-border text-[11px] text-text-muted">
			<div className="flex items-center gap-3 px-4 py-2">
				<span className="truncate">
					{t('editor.articlePreview.capturedFrom', {
						host: hostOf(template.finalUrl),
						time: relativeTime(template.capturedAt),
					})}
				</span>
				<span className="flex-1" />
				<span
					className="hidden xl:inline truncate"
					title={SLOT_KEYS.map(
						(k) =>
							`${t(`editor.articlePreview.slots.${k}`)}: ${template.slots[k]?.selector ?? '—'}`,
					).join('\n')}
				>
					{t('editor.articlePreview.detected', {
						slots: found.map((k) => t(`editor.articlePreview.slots.${k}`)).join(', '),
					})}
				</span>
				{template.warnings.length > 0 && (
					<button
						type="button"
						onClick={onToggleNotes}
						aria-expanded={showNotes}
						className="shrink-0 text-warning hover:underline"
					>
						{t('editor.articlePreview.notes', { count: template.warnings.length })}
					</button>
				)}
			</div>
			{showNotes && template.warnings.length > 0 && (
				<ul className="px-4 pb-3 space-y-1 max-h-32 overflow-auto text-text-secondary">
					{template.warnings.map((w) => (
						<li key={w} className="break-words">
							{w}
						</li>
					))}
				</ul>
			)}
		</footer>
	)
}

/**
 * The "paste a published article" form: the empty state before a collection has a
 * template, and the overlay for changing the article or the detection selectors.
 */
function TemplateSetup({
	canConfigure,
	initialUrl,
	initialSelectors,
	detected,
	openSelectors,
	suggestedUrl,
	capturing,
	error,
	onSubmit,
	onCancel,
}: {
	canConfigure: boolean
	initialUrl?: string
	initialSelectors?: PreviewSelectors
	detected?: PreviewTemplateResponse['slots']
	openSelectors?: boolean
	suggestedUrl?: string | null
	capturing: boolean
	error: CaptureError | null
	onSubmit: (url: string, selectors: PreviewSelectors) => void
	onCancel?: () => void
}) {
	const { t } = useTranslation()
	const [url, setUrl] = useState(initialUrl ?? '')
	const [selectors, setSelectors] = useState<PreviewSelectors>(initialSelectors ?? {})
	const [showSelectors, setShowSelectors] = useState(
		!!openSelectors || !!cleanSelectors(initialSelectors ?? {}),
	)
	const isChange = !!onCancel

	const submit = (e: FormEvent) => {
		e.preventDefault()
		if (!url.trim() || capturing) return
		onSubmit(url, selectors)
	}

	const errorText = error
		? t(`editor.articlePreview.errors.${error.code ?? 'generic'}`, { defaultValue: error.message })
		: null

	return (
		<div className="flex-1 overflow-auto px-6 py-12">
			<form onSubmit={submit} className="mx-auto w-full max-w-md">
				{!isChange && (
					<div className="flex items-center justify-center w-10 h-10 mb-4 rounded-full bg-surface-alt text-text-secondary">
						<EyeIcon className="w-5 h-5" />
					</div>
				)}
				<h2 className="text-base font-semibold text-text">
					{isChange
						? t('editor.articlePreview.setup.changeHeading')
						: t('editor.articlePreview.setup.heading')}
				</h2>
				<p className="mt-1.5 text-sm text-text-secondary leading-relaxed">
					{t('editor.articlePreview.setup.body')}
				</p>

				{canConfigure ? (
					<>
						<label
							htmlFor="article-preview-url"
							className="block mt-6 text-xs font-medium text-text-secondary"
						>
							{t('editor.articlePreview.setup.urlLabel')}
						</label>
						<div className="mt-1.5 flex gap-2">
							<input
								id="article-preview-url"
								type="url"
								inputMode="url"
								required
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder={t('editor.articlePreview.setup.urlPlaceholder')}
								disabled={capturing}
								className="flex-1 min-w-0 px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60"
							/>
							<button
								type="submit"
								disabled={capturing || !url.trim()}
								className="inline-flex items-center gap-2 px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 shrink-0"
							>
								{capturing && <Spinner />}
								{capturing
									? t('editor.articlePreview.setup.capturing')
									: isChange
										? t('editor.articlePreview.setup.recapture')
										: t('editor.articlePreview.setup.capture')}
							</button>
						</div>
						{suggestedUrl && !url && !capturing && (
							<button
								type="button"
								onClick={() => setUrl(suggestedUrl)}
								className="mt-2 max-w-full truncate text-left text-xs text-text-muted hover:text-text-secondary transition-colors"
							>
								{t('editor.articlePreview.setup.useSuggested', { url: shortUrl(suggestedUrl) })}
							</button>
						)}
						{capturing && (
							<p className="mt-3 text-xs text-text-muted">
								{t('editor.articlePreview.setup.capturingHint')}
							</p>
						)}
						{errorText && (
							<p role="alert" className="mt-3 text-sm text-danger leading-relaxed">
								{errorText}
							</p>
						)}

						<button
							type="button"
							onClick={() => setShowSelectors((v) => !v)}
							aria-expanded={showSelectors}
							className="mt-6 inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
								className={`w-3 h-3 transition-transform ${showSelectors ? 'rotate-90' : ''}`}
							>
								<path d="m9 18 6-6-6-6" />
							</svg>
							{t('editor.articlePreview.setup.detection')}
						</button>
						{showSelectors && (
							<div className="mt-3 space-y-3 p-4 rounded-lg border border-border bg-surface-alt/40">
								<p className="text-xs text-text-secondary leading-relaxed">
									{t('editor.articlePreview.setup.detectionHint')}
								</p>
								{SLOT_KEYS.map((key) => (
									<label key={key} className="block">
										<span className="text-xs text-text-secondary">
											{t(`editor.articlePreview.slots.${key}`)}
										</span>
										<input
											type="text"
											value={selectors[key] ?? ''}
											onChange={(e) => setSelectors((s) => ({ ...s, [key]: e.target.value }))}
											placeholder={
												detected?.[key]?.selector ?? t('editor.articlePreview.setup.auto')
											}
											disabled={capturing}
											spellCheck={false}
											className="mt-1 w-full px-3 py-1.5 bg-input border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong disabled:opacity-60"
										/>
									</label>
								))}
							</div>
						)}

						{onCancel && (
							<div className="mt-8">
								<button
									type="button"
									onClick={onCancel}
									disabled={capturing}
									className="text-sm text-text-muted hover:text-text transition-colors disabled:opacity-50"
								>
									{t('common.cancel')}
								</button>
							</div>
						)}
					</>
				) : (
					<p className="mt-6 text-sm text-text-muted leading-relaxed">
						{t('editor.articlePreview.setup.askAdmin')}
					</p>
				)}
			</form>
		</div>
	)
}
