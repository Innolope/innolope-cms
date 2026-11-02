import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../lib/i18n'
import { SyncConflictsDialog } from './sync-conflicts-dialog'

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../lib/api-client', () => ({ api: apiMock }))
type Props = ComponentProps<typeof SyncConflictsDialog>
const legacy = {
	contentId: 'a',
	externalId: 'ext',
	slug: 'Article',
	metadata: {},
	token: 'old',
	categories: ['content' as const],
	preview: true,
}
const fresh = {
	...legacy,
	preview: false,
	fullComparison: true,
	token: 'fresh',
	local: { metadata: {}, markdown: 'Reviewed CMS', status: 'draft' },
	external: { metadata: {}, markdown: 'Reviewed external', status: 'draft' },
}
const fixture = (): Props => ({
	collection: { id: 'collection-a', fields: [] } as unknown as Props['collection'],
	conflicts: [legacy],
	defaultLocale: 'en',
	syncing: false,
	onCancel: vi.fn(),
	onConfirm: vi.fn(),
})
beforeEach(async () => {
	vi.clearAllMocks()
	await i18n.changeLanguage('en')
})

describe('comparison review recovery', () => {
	it('replaces a legacy comparison with its newly reviewed token', async () => {
		apiMock.post.mockResolvedValue({ conflicts: [fresh] })
		const props = fixture()
		render(<SyncConflictsDialog {...props} />)
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Recheck changes' }))
		})
		const choice = screen.getByRole('radio', { name: 'Keep CMS edits' }) as HTMLInputElement
		expect(choice.disabled).toBe(false)
		fireEvent.click(choice)
		fireEvent.click(screen.getByRole('button', { name: 'Apply choices' }))
		expect(props.onConfirm).toHaveBeenCalledWith({ a: { token: 'fresh', choice: 'local' } })
	})
	it('closes an already resolved comparison after rechecking', async () => {
		apiMock.post.mockResolvedValue({ conflicts: [] })
		const props = fixture()
		render(<SyncConflictsDialog {...props} />)
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Recheck changes' }))
		})
		expect(props.onCancel).toHaveBeenCalledTimes(1)
		expect(props.onConfirm).not.toHaveBeenCalled()
	})
	it('shows type-only differences and accepts hostile JSON keys as plain content', () => {
		const props = fixture()
		const item = {
			...fresh,
			local: { ...fresh.local, metadata: { count: 1, flag: false } },
			external: {
				...fresh.external,
				metadata: JSON.parse('{"count":"1","flag":"false","constructor":"changed"}'),
			},
		}
		const { container } = render(<SyncConflictsDialog {...props} conflicts={[item]} />)
		expect(container.textContent).toContain('Number')
		expect(container.textContent).toContain('Text')
		expect(container.querySelectorAll('mark').length).toBeGreaterThan(0)
	})
	it('highlights an empty value versus text matching its display label', () => {
		const props = fixture()
		const item = {
			...fresh,
			local: { ...fresh.local, markdown: '', metadata: { title: '' } },
			external: { ...fresh.external, markdown: '', metadata: { title: 'Empty text' } },
		}
		const { container } = render(<SyncConflictsDialog {...props} conflicts={[item]} />)
		expect(container.querySelector('del')?.textContent).toBe('Empty text')
		expect(container.querySelector('mark')?.textContent).toBe('Empty text')
		expect(container.textContent).toContain('Text')
	})
})
