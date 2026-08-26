import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSource } from '../../lib/media-sources'
import { UploadModal } from './upload-modal'

vi.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('../../lib/toast', () => ({ useToast: () => toastSpy }))

const uploadMock = vi.hoisted(() => vi.fn())
vi.mock('../../lib/media-sources', () => ({ uploadToSource: uploadMock }))

const target = { id: 'library', label: 'Library' } as MediaSource

const file = (name: string) => new File(['data'], name, { type: 'text/plain' })
const imageFile = (name: string) => new File(['png-bytes'], name, { type: 'image/png' })

/** Drop files onto the modal's full-surface drop target. */
const dropFiles = (container: HTMLElement, files: File[]) => {
	const surface = container.firstElementChild as HTMLElement
	fireEvent.drop(surface, { dataTransfer: { files, types: ['Files'] } })
}

/**
 * jsdom has no object-URL support. Model it well enough to tell a *live*
 * preview URL from a revoked one — a revoked src is exactly the bug these
 * tests guard (the browser then shows its broken-image glyph).
 */
const liveObjectUrls = new Set<string>()

describe('UploadModal', () => {
	beforeAll(() => {
		let seq = 0
		Object.assign(URL, {
			createObjectURL: vi.fn(() => {
				const url = `blob:preview-${++seq}`
				liveObjectUrls.add(url)
				return url
			}),
			revokeObjectURL: vi.fn((url: string) => {
				liveObjectUrls.delete(url)
			}),
		})
	})

	beforeEach(() => {
		toastSpy.mockClear()
		uploadMock.mockReset()
	})

	it('starts with an empty queue and a disabled upload button', () => {
		render(<UploadModal target={target} projectId="p1" onClose={() => {}} onUploaded={() => {}} />)
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'mediaRoute.uploadModal.browse' }),
		).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'mediaRoute.uploadModal.uploadCount' }),
		).toBeDisabled()
	})

	it('queues dropped files once each, and remove takes a row back out', () => {
		const { container } = render(
			<UploadModal target={target} projectId="p1" onClose={() => {}} onUploaded={() => {}} />,
		)
		const a = file('a.txt')
		dropFiles(container, [a, file('b.txt')])
		expect(screen.getByText('a.txt')).toBeInTheDocument()
		expect(screen.getByText('b.txt')).toBeInTheDocument()

		// The same file dropped again must not duplicate its row. (Identity is
		// name+size+mtime — a genuinely different file with the same name queues.)
		dropFiles(container, [a])
		expect(screen.getAllByText('a.txt')).toHaveLength(1)

		// Rows render in queue order, so the first remove button belongs to a.txt.
		// (The mocked t() drops interpolation, so both buttons share a name.)
		fireEvent.click(screen.getAllByRole('button', { name: 'mediaRoute.uploadModal.remove' })[0])
		expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
		expect(screen.getByText('b.txt')).toBeInTheDocument()
	})

	it('uploads the queue, then closes and reports success', async () => {
		uploadMock.mockResolvedValue(undefined)
		const onClose = vi.fn()
		const onUploaded = vi.fn()
		const { container } = render(
			<UploadModal target={target} projectId="p1" onClose={onClose} onUploaded={onUploaded} />,
		)
		dropFiles(container, [file('a.txt'), file('b.txt')])
		fireEvent.click(screen.getByRole('button', { name: 'mediaRoute.uploadModal.uploadCount' }))

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
		expect(uploadMock).toHaveBeenCalledTimes(2)
		expect(onUploaded).toHaveBeenCalledOnce()
		expect(toastSpy).toHaveBeenCalledWith('mediaRoute.uploadModal.uploadedCount', 'success')
	})

	it('keeps failed files visible with their error and stays open', async () => {
		uploadMock.mockImplementation((_t: unknown, f: File) =>
			f.name === 'bad.txt' ? Promise.reject(new Error('File is too large')) : Promise.resolve(),
		)
		const onClose = vi.fn()
		const onUploaded = vi.fn()
		const { container } = render(
			<UploadModal target={target} projectId="p1" onClose={onClose} onUploaded={onUploaded} />,
		)
		dropFiles(container, [file('good.txt'), file('bad.txt')])
		fireEvent.click(screen.getByRole('button', { name: 'mediaRoute.uploadModal.uploadCount' }))

		await waitFor(() => expect(screen.getByText('File is too large')).toBeInTheDocument())
		// The success is cleared from the list; the failure stays; the modal stays.
		expect(screen.queryByText('good.txt')).not.toBeInTheDocument()
		expect(screen.getByText('bad.txt')).toBeInTheDocument()
		expect(onClose).not.toHaveBeenCalled()
		expect(onUploaded).toHaveBeenCalledOnce()
		expect(toastSpy).toHaveBeenCalledWith('mediaRoute.uploadModal.partialFailed', 'error')
	})

	it('previews queued images with live object URLs under StrictMode', () => {
		// StrictMode runs effects mount → cleanup → mount, which is what used to
		// revoke the previews of page-dropped files and leave dead srcs behind.
		const { container, unmount } = render(
			<UploadModal
				target={target}
				projectId="p1"
				initialFiles={[imageFile('page-drop.png')]}
				onClose={() => {}}
				onUploaded={() => {}}
			/>,
			{ wrapper: StrictMode },
		)
		const liveSrcs = () =>
			[...container.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '')

		expect(liveSrcs()).toHaveLength(1)
		expect(liveSrcs().every((src) => liveObjectUrls.has(src))).toBe(true)

		dropFiles(container, [imageFile('picked.png')])
		expect(liveSrcs()).toHaveLength(2)
		expect(liveSrcs().every((src) => liveObjectUrls.has(src))).toBe(true)

		// Non-images get the extension badge instead of an <img>.
		dropFiles(container, [file('notes.txt')])
		expect(liveSrcs()).toHaveLength(2)
		expect(screen.getByText('txt')).toBeInTheDocument()

		// Removing a row and closing the modal release what they created.
		const removed = liveSrcs()
		fireEvent.click(screen.getAllByRole('button', { name: 'mediaRoute.uploadModal.remove' })[0])
		unmount()
		expect(removed.some((src) => liveObjectUrls.has(src))).toBe(false)
	})

	it('falls back to the extension badge when a preview fails to load', () => {
		const { container } = render(
			<UploadModal
				target={target}
				projectId="p1"
				initialFiles={[imageFile('broken.png')]}
				onClose={() => {}}
				onUploaded={() => {}}
			/>,
		)
		const img = container.querySelector('img') as HTMLImageElement
		fireEvent.error(img)
		expect(container.querySelector('img')).toBeNull()
		expect(screen.getByText('png')).toBeInTheDocument()
	})

	it('seeds the queue from files dropped on the page before it opened', () => {
		render(
			<UploadModal
				target={target}
				projectId="p1"
				initialFiles={[file('page-drop.txt')]}
				onClose={() => {}}
				onUploaded={() => {}}
			/>,
		)
		expect(screen.getByText('page-drop.txt')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'mediaRoute.uploadModal.uploadCount' })).toBeEnabled()
	})
})
