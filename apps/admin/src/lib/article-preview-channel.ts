import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreviewContent } from './article-preview'

/**
 * The article preview can open in its own browser tab. That tab gets the record's
 * content, unsaved edits included, from the editor over this same-browser channel:
 * nothing leaves the browser, and the tab keeps updating after the editor's side
 * panel is closed. One channel serves every record; messages name theirs.
 *
 *   tab    → `hello`    "I show record X" (on open, and when an editor appears)
 *   editor → `ready`    "an editor for X is open" (on load, and when its page shows again)
 *   editor → `content`  X's current content (after a hello, then on every edit)
 *   editor → `closed`   "this editor of X went away" (unmount, page hidden)
 *   panel  → `template` "collection C's layout changed" (re-copied or removed)
 */
export const PREVIEW_CHANNEL = 'innolope:article-preview'

/** What a preview tab needs to render a record: its collection's layout and its content. */
export interface PreviewFeed {
	collectionId: string
	content: PreviewContent
}

type PreviewMessage =
	| { type: 'hello' | 'ready' | 'closed'; contentId: string }
	| ({ type: 'content'; contentId: string } & PreviewFeed)
	| { type: 'template'; collectionId: string }

const channelSupported = () => typeof BroadcastChannel !== 'undefined'

function parseFeed(value: unknown): PreviewFeed | null {
	if (!value || typeof value !== 'object') return null
	const { collectionId, content } = value as Record<string, unknown>
	if (typeof collectionId !== 'string' || !content || typeof content !== 'object') return null
	const fields = content as Record<string, unknown>
	if (typeof fields.title !== 'string' || typeof fields.markdown !== 'string') return null
	const parsed: PreviewContent = { title: fields.title, markdown: fields.markdown }
	for (const key of ['imageUrl', 'imageAlt', 'locale'] as const) {
		const v = fields[key]
		if (typeof v === 'string' || v === null) parsed[key] = v
	}
	return { collectionId, content: parsed }
}

/** Another tab of the same origin can post anything here; take only well-formed messages. */
function parseMessage(data: unknown): PreviewMessage | null {
	if (!data || typeof data !== 'object') return null
	const m = data as Record<string, unknown>
	if (m.type === 'template')
		return typeof m.collectionId === 'string'
			? { type: 'template', collectionId: m.collectionId }
			: null
	if (typeof m.contentId !== 'string') return null
	if (m.type === 'hello' || m.type === 'ready' || m.type === 'closed')
		return { type: m.type, contentId: m.contentId }
	if (m.type === 'content') {
		const feed = parseFeed(m)
		return feed ? { type: 'content', contentId: m.contentId, ...feed } : null
	}
	return null
}

export interface PreviewHost {
	/** The editor's latest content; sent at once if a tab is watching. */
	publish(feed: PreviewFeed): void
	/** The editor page is going away or into the back-forward cache. */
	hide(): void
	/** The editor page is showing again. */
	show(): void
	close(): void
}

/**
 * The editor's end. Quiet until a preview tab for this record says hello, so an
 * editor nobody is previewing posts nothing.
 */
export function hostPreview(contentId: string, onListening: () => void): PreviewHost {
	const channel = new BroadcastChannel(PREVIEW_CHANNEL)
	let feed: PreviewFeed | null = null
	let listening = false
	let hidden = false
	let closed = false
	const send = (message: PreviewMessage) => {
		if (!closed) channel.postMessage(message)
	}
	const sendFeed = () => {
		if (feed && listening && !hidden) send({ type: 'content', contentId, ...feed })
	}
	channel.onmessage = (event: MessageEvent) => {
		const message = parseMessage(event.data)
		if (message?.type !== 'hello' || message.contentId !== contentId) return
		if (!listening) {
			listening = true
			onListening()
		}
		sendFeed()
	}
	send({ type: 'ready', contentId })
	return {
		publish(next) {
			feed = next
			sendFeed()
		},
		hide() {
			if (hidden) return
			hidden = true
			if (listening) send({ type: 'closed', contentId })
		},
		show() {
			if (!hidden) return
			hidden = false
			send({ type: 'ready', contentId })
		},
		close() {
			if (listening && !hidden) send({ type: 'closed', contentId })
			closed = true
			channel.close()
		},
	}
}

/**
 * The preview tab's end. Says hello on open, and again whenever an editor of the
 * record appears or one of several goes away, so it reconnects on its own.
 */
export function followPreview(
	contentId: string,
	handlers: {
		onContent: (feed: PreviewFeed) => void
		onClosed: () => void
		onTemplate: (collectionId: string) => void
	},
): { close(): void } {
	const channel = new BroadcastChannel(PREVIEW_CHANNEL)
	const hello = () => channel.postMessage({ type: 'hello', contentId } satisfies PreviewMessage)
	channel.onmessage = (event: MessageEvent) => {
		const message = parseMessage(event.data)
		if (!message) return
		if (message.type === 'template') {
			handlers.onTemplate(message.collectionId)
			return
		}
		if (message.contentId !== contentId) return
		if (message.type === 'content')
			handlers.onContent({ collectionId: message.collectionId, content: message.content })
		else if (message.type === 'closed') {
			handlers.onClosed()
			hello()
		} else if (message.type === 'ready') hello()
	}
	hello()
	return { close: () => channel.close() }
}

/** Tell open preview tabs that a collection's layout was re-copied or removed. */
export function announceTemplateChange(collectionId: string): void {
	if (!channelSupported()) return
	const channel = new BroadcastChannel(PREVIEW_CHANNEL)
	channel.postMessage({ type: 'template', collectionId } satisfies PreviewMessage)
	channel.close()
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
const cacheKey = (contentId: string) => `innolope:article-preview:tab:${contentId}`

/**
 * The tab keeps the last version it showed in its own session storage, so a reload
 * shows it at once — and still shows it when the editor has since been closed.
 */
export function readCachedFeed(storage: StorageLike | null, contentId: string): PreviewFeed | null {
	try {
		return parseFeed(JSON.parse(storage?.getItem(cacheKey(contentId)) ?? 'null'))
	} catch {
		return null
	}
}

export function writeCachedFeed(
	storage: StorageLike | null,
	contentId: string,
	feed: PreviewFeed,
): void {
	try {
		storage?.setItem(cacheKey(contentId), JSON.stringify(feed))
	} catch {
		// Full or blocked storage only costs the instant view after a reload.
	}
}

function sessionStore(): Storage | null {
	try {
		return window.sessionStorage
	} catch {
		return null
	}
}

/**
 * Editor side. `listening` turns true once a preview tab for the record has said
 * hello; until then the editor posts nothing (and needn't resolve the cover image).
 */
export function useArticlePreviewHost(contentId: string | null): {
	listening: boolean
	publish: (feed: PreviewFeed) => void
} {
	const [listening, setListening] = useState(false)
	const hostRef = useRef<PreviewHost | null>(null)
	const latestRef = useRef<PreviewFeed | null>(null)

	useEffect(() => {
		setListening(false)
		if (!contentId || !channelSupported()) return
		const host = hostPreview(contentId, () => setListening(true))
		if (latestRef.current) host.publish(latestRef.current)
		hostRef.current = host
		const hide = () => host.hide()
		const show = () => host.show()
		window.addEventListener('pagehide', hide)
		window.addEventListener('pageshow', show)
		return () => {
			window.removeEventListener('pagehide', hide)
			window.removeEventListener('pageshow', show)
			host.close()
			hostRef.current = null
		}
	}, [contentId])

	const publish = useCallback((feed: PreviewFeed) => {
		latestRef.current = feed
		hostRef.current?.publish(feed)
	}, [])

	return { listening, publish }
}

/** `live`: an editor is sending; `connecting`: none has answered yet; `closed`: none is open. */
export type PreviewLink = 'connecting' | 'live' | 'closed'

/** How long a new tab waits for an editor before saying none is open. */
const CONNECT_TIMEOUT_MS = 1500
const CACHE_DEBOUNCE_MS = 500

/** Preview-tab side: the record's latest content and the state of the link to the editor. */
export function useArticlePreviewFeed(contentId: string): {
	feed: PreviewFeed | null
	link: PreviewLink
	/** Bumps when another tab re-copies or removes a collection's layout. */
	templateChange: { collectionId: string; count: number } | null
} {
	const [feed, setFeed] = useState<PreviewFeed | null>(() =>
		readCachedFeed(sessionStore(), contentId),
	)
	const [link, setLink] = useState<PreviewLink>('connecting')
	const [templateChange, setTemplateChange] = useState<{
		collectionId: string
		count: number
	} | null>(null)

	useEffect(() => {
		setFeed(readCachedFeed(sessionStore(), contentId))
		if (!channelSupported()) {
			setLink('closed')
			return
		}
		setLink('connecting')
		const follower = followPreview(contentId, {
			onContent: (next) => {
				setFeed(next)
				setLink('live')
			},
			onClosed: () => setLink('closed'),
			onTemplate: (collectionId) =>
				setTemplateChange((prev) => ({ collectionId, count: (prev?.count ?? 0) + 1 })),
		})
		const timer = window.setTimeout(
			() => setLink((current) => (current === 'connecting' ? 'closed' : current)),
			CONNECT_TIMEOUT_MS,
		)
		return () => {
			window.clearTimeout(timer)
			follower.close()
		}
	}, [contentId])

	useEffect(() => {
		if (!feed) return
		const timer = window.setTimeout(
			() => writeCachedFeed(sessionStore(), contentId, feed),
			CACHE_DEBOUNCE_MS,
		)
		return () => window.clearTimeout(timer)
	}, [contentId, feed])

	return { feed, link, templateChange }
}
