import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	ArticlePreviewModal,
	clearPreviewTemplateCache,
	type PreviewTemplateResponse,
} from './article-preview-panel'

const apiGet = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../lib/api-client', () => ({
	ApiError: class ApiError extends Error {},
	api: { get: apiGet, post: vi.fn(), delete: vi.fn() },
}))
vi.mock('../../lib/relative-time', () => ({ relativeTime: () => 'just now' }))
vi.mock('../../lib/toast', () => ({ useToast: () => vi.fn() }))
vi.mock('../../lib/confirm', () => ({ useConfirm: () => vi.fn() }))
vi.mock('../../lib/collections', () => ({ useCollections: () => ({}) }))
vi.mock('../../lib/article-preview-channel', () => ({
	announceTemplateChange: vi.fn(),
	useArticlePreviewHost: () => ({ listening: false, publish: vi.fn() }),
}))

const DEVICE_KEY = 'innolope:article-preview:device'

const template: PreviewTemplateResponse = {
	collectionId: 'c1',
	sourceUrl: 'https://blog.example.com/posts/hello',
	finalUrl: 'https://blog.example.com/posts/hello',
	html: '<!doctype html><html><head></head><body><h1>Hello</h1><div>Body</div></body></html>',
	slots: {
		title: { selector: 'h1', strategy: 'semantic' },
		body: { selector: 'div', strategy: 'heuristic' },
		image: null,
	},
	classMap: {},
	selectors: null,
	warnings: [],
	stats: { bytes: 100, stylesheets: 0, inlinedFonts: 0 },
	capturedAt: '2026-11-01T10:00:00.000Z',
}

function props(overrides: Partial<Parameters<typeof ArticlePreviewModal>[0]> = {}) {
	return {
		collectionId: 'c1',
		canConfigure: true,
		content: { title: 'Draft', markdown: 'Text', imageUrl: null, locale: null },
		tabHref: '/collections/posts/r1/preview',
		onClose: vi.fn(),
		...overrides,
	}
}

/** Renders the modal and waits for its layout to load (the device switch shows with it). */
async function open(overrides: Partial<Parameters<typeof ArticlePreviewModal>[0]> = {}) {
	const p = props(overrides)
	const view = render(<ArticlePreviewModal {...p} />)
	await screen.findByRole('radiogroup')
	return { ...view, onClose: p.onClose }
}

const pressEscape = () => fireEvent.keyDown(document, { key: 'Escape' })

beforeEach(() => {
	clearPreviewTemplateCache()
	const values = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
		clear: () => values.clear(),
	})
	apiGet.mockReset()
	apiGet.mockResolvedValue({ template })
	// jsdom has no layout; the frame waits for a size it never gets, which is fine here.
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('the preview modal', () => {
	it('closes on Esc', async () => {
		const { onClose } = await open()
		pressEscape()
		expect(onClose).toHaveBeenCalledOnce()
	})

	it('leaves Esc to a dialog opened on top of it', async () => {
		const { onClose } = await open()
		const confirm = document.createElement('div')
		confirm.setAttribute('role', 'dialog')
		confirm.setAttribute('aria-modal', 'true')
		document.body.append(confirm)
		pressEscape()
		expect(onClose).not.toHaveBeenCalled()

		confirm.remove()
		pressEscape()
		expect(onClose).toHaveBeenCalledOnce()
	})

	it('closes an open options menu on Esc before closing itself', async () => {
		const { onClose } = await open()
		fireEvent.click(screen.getByRole('button', { name: 'editor.articlePreview.menu.label' }))
		expect(screen.getByText('editor.articlePreview.menu.remove')).toBeInTheDocument()

		pressEscape()
		expect(screen.queryByText('editor.articlePreview.menu.remove')).not.toBeInTheDocument()
		expect(onClose).not.toHaveBeenCalled()

		pressEscape()
		expect(onClose).toHaveBeenCalledOnce()
	})

	it('backs out of the change-layout form on Esc before closing', async () => {
		const { onClose } = await open()
		fireEvent.click(screen.getByRole('button', { name: 'editor.articlePreview.menu.label' }))
		fireEvent.click(screen.getByText('editor.articlePreview.menu.changeArticle'))
		expect(screen.getByText('editor.articlePreview.setup.changeHeading')).toBeInTheDocument()

		pressEscape()
		expect(screen.queryByText('editor.articlePreview.setup.changeHeading')).not.toBeInTheDocument()
		expect(onClose).not.toHaveBeenCalled()
	})

	it('offers Desktop and Mobile in the top bar and remembers the pick', async () => {
		// A width kept from the old side panel that the modal doesn't offer.
		localStorage.setItem(DEVICE_KEY, 'tablet')
		await open()
		const radios = screen.getAllByRole('radio')
		expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
			'editor.articlePreview.device.desktop',
			'editor.articlePreview.device.mobile',
		])
		const [desktop, mobile] = radios
		expect(desktop).toHaveAttribute('aria-checked', 'true')

		fireEvent.click(mobile)
		expect(mobile).toHaveAttribute('aria-checked', 'true')
		expect(desktop).toHaveAttribute('aria-checked', 'false')
		expect(localStorage.getItem(DEVICE_KEY)).toBe('mobile')
	})

	it('moves between the widths with the arrow keys as one tab stop', async () => {
		await open()
		const [desktop, mobile] = screen.getAllByRole('radio')
		expect(desktop).toHaveAttribute('tabindex', '0')
		expect(mobile).toHaveAttribute('tabindex', '-1')

		desktop.focus()
		fireEvent.keyDown(desktop, { key: 'ArrowRight' })
		expect(mobile).toHaveAttribute('aria-checked', 'true')
		expect(mobile).toHaveFocus()
		expect(mobile).toHaveAttribute('tabindex', '0')

		// Wraps around.
		fireEvent.keyDown(mobile, { key: 'ArrowRight' })
		expect(desktop).toHaveAttribute('aria-checked', 'true')
		expect(desktop).toHaveFocus()
	})

	it('takes focus when it opens and gives it back to the opener when it closes', async () => {
		const opener = document.createElement('button')
		document.body.append(opener)
		opener.focus()
		const { unmount } = await open()
		expect(screen.getByRole('dialog')).toHaveFocus()

		unmount()
		expect(opener).toHaveFocus()
		opener.remove()
	})

	it('keeps Tab inside the preview', async () => {
		await open()
		const dialog = screen.getByRole('dialog')
		const close = screen.getByRole('button', { name: 'editor.articlePreview.close' })
		const source = screen.getByTitle('editor.articlePreview.openSource')

		close.focus()
		fireEvent.keyDown(close, { key: 'Tab' })
		expect(source).toHaveFocus()

		fireEvent.keyDown(source, { key: 'Tab', shiftKey: true })
		expect(close).toHaveFocus()

		// Focus that escapes (tabbing out of the frame's own document) is pulled back.
		const behind = document.createElement('button')
		document.body.append(behind)
		behind.focus()
		expect(dialog.contains(document.activeElement)).toBe(true)
		behind.remove()
	})

	it('shows the layout at once when reopened, and still re-checks it', async () => {
		const first = await open()
		first.unmount()

		let release: (value: unknown) => void = () => {}
		apiGet.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
		render(<ArticlePreviewModal {...props()} />)
		// No spinner first: the cached layout is on screen before the API answers.
		expect(screen.getByRole('radiogroup')).toBeInTheDocument()
		expect(apiGet).toHaveBeenCalledTimes(2)

		// A newer capture from elsewhere replaces it.
		await act(async () =>
			release({
				template: {
					...template,
					finalUrl: 'https://new.example.com/a',
					capturedAt: '2026-11-02T10:00:00.000Z',
				},
			}),
		)
		await waitFor(() => expect(screen.getByText('new.example.com/a')).toBeInTheDocument())
	})

	it('keeps the cached layout when the re-check fails', async () => {
		;(await open()).unmount()
		apiGet.mockRejectedValueOnce(new Error('offline'))
		render(<ArticlePreviewModal {...props()} />)
		await act(async () => {})
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		expect(screen.getByRole('radiogroup')).toBeInTheDocument()
	})
})
