// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	announceTemplateChange,
	followPreview,
	hostPreview,
	PREVIEW_CHANNEL,
	type PreviewFeed,
	readCachedFeed,
	writeCachedFeed,
} from './article-preview-channel'

/**
 * The editor and a preview tab talk over one same-browser BroadcastChannel. These
 * tests run both ends in one process, where Node's BroadcastChannel delivers between
 * instances asynchronously.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

const feed = (title: string, collectionId = 'col-1'): PreviewFeed => ({
	collectionId,
	content: { title, markdown: `Body of ${title}`, imageUrl: null, locale: 'en' },
})

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

function host(contentId: string, onListening = () => {}) {
	const h = hostPreview(contentId, onListening)
	cleanups.push(() => h.close())
	return h
}

function follow(contentId: string) {
	const handlers = { onContent: vi.fn(), onClosed: vi.fn(), onTemplate: vi.fn() }
	const f = followPreview(contentId, handlers)
	cleanups.push(() => f.close())
	return handlers
}

function tap() {
	const seen: unknown[] = []
	const channel = new BroadcastChannel(PREVIEW_CHANNEL)
	channel.onmessage = (event) => seen.push(event.data)
	cleanups.push(() => channel.close())
	return seen
}

describe('article preview channel', () => {
	it("answers a tab's hello with the editor's current content", async () => {
		const onListening = vi.fn()
		const editor = host('rec-1', onListening)
		editor.publish(feed('Draft title'))
		const tab = follow('rec-1')
		await settle()
		expect(onListening).toHaveBeenCalledOnce()
		expect(tab.onContent).toHaveBeenLastCalledWith(feed('Draft title'))
	})

	it('sends every later edit to the tab', async () => {
		const editor = host('rec-1')
		editor.publish(feed('First'))
		const tab = follow('rec-1')
		await settle()
		editor.publish(feed('Second'))
		await settle()
		expect(tab.onContent).toHaveBeenLastCalledWith(feed('Second'))
	})

	it('stays quiet until a preview tab for its record says hello', async () => {
		const seen = tap()
		const editor = host('rec-1')
		editor.publish(feed('Nobody is watching'))
		editor.publish(feed('Still nobody'))
		await settle()
		expect(seen.filter((m) => (m as { type: string }).type === 'content')).toEqual([])
	})

	it('keeps two records apart', async () => {
		const a = host('rec-a')
		const b = host('rec-b')
		a.publish(feed('Record A'))
		b.publish(feed('Record B'))
		const tabA = follow('rec-a')
		const tabB = follow('rec-b')
		await settle()
		b.publish(feed('Record B edited'))
		await settle()
		expect(tabA.onContent.mock.calls.map(([f]) => f.content.title)).toEqual(['Record A'])
		expect(tabB.onContent).toHaveBeenLastCalledWith(feed('Record B edited'))
	})

	it('tells the tab when the editor closes, and another editor of the record takes over', async () => {
		const first = host('rec-1')
		first.publish(feed('From the first editor'))
		const second = hostPreview('rec-1', () => {})
		second.publish(feed('From the second editor'))
		const tab = follow('rec-1')
		await settle()
		tab.onContent.mockClear()
		first.close()
		await settle()
		expect(tab.onClosed).toHaveBeenCalled()
		expect(tab.onContent).toHaveBeenLastCalledWith(feed('From the second editor'))
		second.close()
	})

	it('reconnects a waiting tab when the editor comes back (reload, reopened tab)', async () => {
		const tab = follow('rec-1')
		await settle()
		expect(tab.onContent).not.toHaveBeenCalled()
		const editor = host('rec-1')
		editor.publish(feed('Back again'))
		await settle()
		expect(tab.onContent).toHaveBeenLastCalledWith(feed('Back again'))
	})

	it('reports a hidden editor page as closed and announces it again when shown', async () => {
		const editor = host('rec-1')
		editor.publish(feed('Before hiding'))
		const tab = follow('rec-1')
		await settle()
		editor.hide()
		await settle()
		expect(tab.onClosed).toHaveBeenCalled()
		tab.onContent.mockClear()
		editor.show()
		await settle()
		expect(tab.onContent).toHaveBeenLastCalledWith(feed('Before hiding'))
	})

	it('relays layout changes to every open tab', async () => {
		const tab = follow('rec-1')
		announceTemplateChange('col-9')
		await settle()
		expect(tab.onTemplate).toHaveBeenCalledWith('col-9')
	})

	it('ignores malformed messages', async () => {
		const tab = follow('rec-1')
		const stray = new BroadcastChannel(PREVIEW_CHANNEL)
		for (const message of [null, 'text', 42, { type: 'content', contentId: 'rec-1' }, {}])
			stray.postMessage(message)
		await settle()
		stray.close()
		expect(tab.onContent).not.toHaveBeenCalled()
		expect(tab.onClosed).not.toHaveBeenCalled()
	})
})

describe('preview tab cache', () => {
	const memoryStorage = () => {
		const data = new Map<string, string>()
		return {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value),
		}
	}

	it('keeps the last version per record so a reloaded tab shows it at once', () => {
		const storage = memoryStorage()
		writeCachedFeed(storage, 'rec-1', feed('Cached'))
		expect(readCachedFeed(storage, 'rec-1')).toEqual(feed('Cached'))
		expect(readCachedFeed(storage, 'rec-2')).toBeNull()
	})

	it('treats corrupt or unavailable storage as empty', () => {
		const storage = memoryStorage()
		storage.setItem('innolope:article-preview:tab:rec-1', '{not json')
		expect(readCachedFeed(storage, 'rec-1')).toBeNull()
		storage.setItem('innolope:article-preview:tab:rec-1', JSON.stringify({ content: 'nope' }))
		expect(readCachedFeed(storage, 'rec-1')).toBeNull()
		const broken = {
			getItem: () => {
				throw new Error('denied')
			},
			setItem: () => {
				throw new Error('quota')
			},
		}
		expect(readCachedFeed(broken, 'rec-1')).toBeNull()
		expect(() => writeCachedFeed(broken, 'rec-1', feed('Too big'))).not.toThrow()
	})
})
