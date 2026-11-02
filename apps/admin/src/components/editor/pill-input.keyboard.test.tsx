import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '../../lib/i18n'
import { PillInput } from './pill-input'

it('starts upward navigation at the last suggestion', () => {
	const changed = vi.fn()
	render(
		<PillInput
			value={[]}
			onChange={changed}
			onDraftChange={vi.fn()}
			suggestions={['Alpha', 'Beta', 'Gamma']}
		/>,
	)
	const input = screen.getByRole('combobox')
	fireEvent.keyDown(input, { key: 'ArrowUp' })
	fireEvent.keyDown(input, { key: 'Enter' })
	expect(changed).toHaveBeenCalledExactlyOnceWith(['Gamma'])
})
