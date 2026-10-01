import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../lib/i18n'
import { api } from '../../lib/api-client'
import i18n from '../../lib/i18n'
import { BulkActionsBar } from './bulk-actions-bar'

vi.mock('../../lib/api-client', () => ({ api: { post: vi.fn() } }))
vi.mock('../../lib/toast', () => ({ useToast: () => vi.fn() }))
vi.mock('../../lib/confirm', () => ({ useConfirm: () => vi.fn() }))
const props = {
	selectedIds: ['a'],
	total: 491,
	allMatching: false,
	onSelectAllMatching: vi.fn(),
	onClear: vi.fn(),
	filter: { collectionId: 'courses' },
	fields: [],
	showSubmitForReview: true,
	onDone: vi.fn(),
}
beforeEach(async () => {
	vi.clearAllMocks()
	await i18n.changeLanguage('en')
	vi.mocked(api.post).mockResolvedValue({
		action: 'duplicate',
		succeeded: 1,
		failed: 0,
		results: [],
	})
})
describe('record selection actions', () => {
	it('keeps statuses in a dropdown and exposes duplication directly', () => {
		render(<BulkActionsBar {...props} />)
		expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Duplicate' })).toBeEnabled()
		fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
		fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
		expect(api.post).toHaveBeenCalledWith('/api/v1/content/bulk-action', {
			action: 'archive',
			ids: ['a'],
		})
	})
	it('duplicates the full matching filter and refreshes the records after success', async () => {
		render(<BulkActionsBar {...props} allMatching />)
		fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
		expect(api.post).toHaveBeenCalledWith('/api/v1/content/bulk-action', {
			action: 'duplicate',
			filter: props.filter,
		})
		await waitFor(() => expect(props.onDone).toHaveBeenCalled())
	})
	it('omits review when the feature is unavailable', () => {
		render(<BulkActionsBar {...props} showSubmitForReview={false} />)
		fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
		expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
	})
})
