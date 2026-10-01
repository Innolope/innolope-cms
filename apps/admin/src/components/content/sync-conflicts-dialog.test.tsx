import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../lib/i18n'
import type { CollectionWithCount } from '../../lib/collections'
import i18n from '../../lib/i18n'
import { SyncConflictsDialog } from './sync-conflicts-dialog'

const collection = { fields: [{ name: 'title', type: 'text' }] } as CollectionWithCount
const conflict = {
	contentId: 'a',
	externalId: 'external-id',
	slug: null,
	metadata: { title: 'Digital Marketing Advanced' },
	token: 'reviewed-version',
	categories: ['content' as const],
}
const props = {
	conflicts: [conflict],
	collection,
	defaultLocale: 'en',
	syncing: false,
	onCancel: vi.fn(),
	onConfirm: vi.fn(),
}
beforeEach(async () => {
	vi.clearAllMocks()
	await i18n.changeLanguage('en')
})
describe('friendly conflict choices', () => {
	it('shows the record title without technical ids or a field diff', () => {
		render(<SyncConflictsDialog {...props} />)
		expect(screen.getByRole('dialog')).toHaveTextContent('Digital Marketing Advanced')
		expect(screen.getByRole('dialog')).not.toHaveTextContent('external-id')
		expect(screen.getByRole('dialog')).not.toHaveTextContent('metadata.')
		expect(screen.getByRole('button', { name: 'Apply choices' })).toBeDisabled()
		fireEvent.click(screen.getByRole('radio', { name: 'Keep CMS edits' }))
		fireEvent.click(screen.getByRole('button', { name: 'Apply choices' }))
		expect(props.onConfirm).toHaveBeenCalledWith({
			a: { token: 'reviewed-version', choice: 'local' },
		})
	})
	it('requires a new decision if the external version changes', () => {
		const { rerender } = render(<SyncConflictsDialog {...props} />)
		fireEvent.click(screen.getByRole('radio', { name: 'Use external edits' }))
		rerender(<SyncConflictsDialog {...props} conflicts={[{ ...conflict, token: 'new-version' }]} />)
		expect(screen.getByRole('button', { name: 'Apply choices' })).toBeDisabled()
	})
	it('renders the Ukrainian choices', async () => {
		await i18n.changeLanguage('uk')
		render(<SyncConflictsDialog {...props} />)
		expect(screen.getByRole('radio', { name: 'Зберегти зміни CMS' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Застосувати вибір' })).toBeDisabled()
	})
})
