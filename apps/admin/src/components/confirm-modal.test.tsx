import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmModal } from './confirm-modal'

vi.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}))

describe('ConfirmModal', () => {
	it('renders title/message and invokes onCancel from the cancel button', () => {
		const onCancel = vi.fn()
		const onConfirm = vi.fn()
		render(
			<ConfirmModal
				title="Delete post"
				message="Are you sure?"
				confirmLabel="Delete"
				cancelLabel="Cancel"
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		)
		expect(screen.getByText('Delete post')).toBeInTheDocument()
		expect(screen.getByText('Are you sure?')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(onCancel).toHaveBeenCalledOnce()
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it('keeps confirm disabled until the required text matches exactly', () => {
		const onConfirm = vi.fn()
		render(
			<ConfirmModal
				title="t"
				message="m"
				confirmLabel="Delete"
				requireText="DELETE"
				onConfirm={onConfirm}
				onCancel={() => {}}
			/>,
		)
		const confirm = screen.getByRole('button', { name: 'Delete' })
		expect(confirm).toBeDisabled()

		fireEvent.change(screen.getByPlaceholderText('DELETE'), { target: { value: 'DELE' } })
		expect(confirm).toBeDisabled()

		fireEvent.change(screen.getByPlaceholderText('DELETE'), { target: { value: 'DELETE' } })
		expect(confirm).toBeEnabled()
		fireEvent.click(confirm)
		expect(onConfirm).toHaveBeenCalledOnce()
	})
})
