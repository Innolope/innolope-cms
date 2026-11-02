import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../lib/i18n'
import { TagInput } from './tag-input'

const apiGet = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api-client', () => ({ api: { get: apiGet } }))

function deferred<T>() {
	let release: (value: T) => void = () => {
		throw new Error('Deferred promise not initialized')
	}
	const promise = new Promise<T>((resolve) => {
		release = resolve
	})
	return { promise, resolve: (value: T) => release(value) }
}

async function advance(milliseconds = 200) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(milliseconds)
	})
}

function ControlledTags({
	onChange,
	initial = [],
}: {
	onChange: (value: string[]) => void
	initial?: string[]
}) {
	const [value, setValue] = useState(initial)
	return (
		<TagInput
			collectionId="collection-a"
			projectId="project-a"
			value={value}
			onChange={(next) => {
				onChange(next)
				setValue(next)
			}}
		/>
	)
}

beforeAll(async () => {
	await i18n.changeLanguage('en')
})
beforeEach(() => {
	vi.useFakeTimers()
	apiGet.mockReset()
	apiGet.mockResolvedValue({ suggestions: [] })
})
afterEach(() => {
	cleanup()
	vi.clearAllTimers()
	vi.useRealTimers()
})

describe('TagInput independent acceptance', () => {
	it('waits for three normalized Unicode codepoints and debounces for 200ms', async () => {
		render(
			<TagInput collectionId="collection-a" projectId="project-a" value={[]} onChange={vi.fn()} />,
		)
		const input = screen.getByRole('combobox')
		fireEvent.change(input, { target: { value: '  😀😀  ' } })
		await advance(300)
		expect(apiGet).not.toHaveBeenCalled()
		fireEvent.change(input, { target: { value: '😀😀😀' } })
		await advance(199)
		expect(apiGet).not.toHaveBeenCalled()
		await advance(1)
		expect(apiGet).toHaveBeenCalledTimes(1)
		expect(apiGet.mock.calls[0]?.[0]).toContain('/collections/collection-a/tag-suggestions')
	})

	it('restarts the debounce when the draft changes', async () => {
		render(<TagInput collectionId="collection-a" value={[]} onChange={vi.fn()} />)
		const input = screen.getByRole('combobox')
		fireEvent.change(input, { target: { value: 'alp' } })
		await advance(150)
		fireEvent.change(input, { target: { value: 'alph' } })
		await advance(150)
		expect(apiGet).not.toHaveBeenCalled()
		await advance(50)
		expect(apiGet).toHaveBeenCalledTimes(1)
	})

	it.each([
		'mouse',
		'keyboard',
	])('excludes selected tags and adds exactly the %s choice once', async (method) => {
		apiGet.mockResolvedValue({ suggestions: ['Alpha', 'Alphabet', 'Alpine'] })
		const onChange = vi.fn()
		render(<ControlledTags initial={['ALPHA']} onChange={onChange} />)
		const input = screen.getByRole('combobox') as HTMLInputElement
		fireEvent.change(input, { target: { value: 'alp' } })
		await advance()
		expect(screen.getByRole('listbox')).toBeTruthy()
		expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull()
		if (method === 'mouse') {
			fireEvent.mouseDown(screen.getByRole('option', { name: 'Alphabet' }))
			const option = screen.queryByRole('option', { name: 'Alphabet' })
			if (option) fireEvent.click(option)
		} else {
			fireEvent.keyDown(input, { key: 'ArrowDown' })
			fireEvent.keyDown(input, { key: 'Enter' })
		}
		fireEvent.blur(input)
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenLastCalledWith(['ALPHA', 'Alphabet'])
		expect(input.value).toBe('')
	})

	it('dismisses suggestions with Escape without losing the draft', async () => {
		apiGet.mockResolvedValue({ suggestions: ['Alphabet'] })
		render(<TagInput collectionId="collection-a" value={[]} onChange={vi.fn()} />)
		const input = screen.getByRole('combobox') as HTMLInputElement
		fireEvent.change(input, { target: { value: 'alp' } })
		await advance()
		expect(screen.getByRole('option', { name: 'Alphabet' })).toBeTruthy()
		fireEvent.keyDown(input, { key: 'Escape' })
		expect(screen.queryByRole('listbox')).toBeNull()
		expect(input.value).toBe('alp')
	})

	it('ignores an older response even when it arrives after the latest result', async () => {
		const old = deferred<{ suggestions: string[] }>()
		const current = deferred<{ suggestions: string[] }>()
		apiGet.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
		render(<TagInput collectionId="collection-a" value={[]} onChange={vi.fn()} />)
		const input = screen.getByRole('combobox')
		fireEvent.change(input, { target: { value: 'alp' } })
		await advance()
		fireEvent.change(input, { target: { value: 'bet' } })
		await advance()
		await act(async () => {
			current.resolve({ suggestions: ['Beta current'] })
		})
		expect(screen.getByRole('option', { name: 'Beta current' })).toBeTruthy()
		await act(async () => {
			old.resolve({ suggestions: ['Alpha stale'] })
		})
		expect(screen.queryByRole('option', { name: 'Alpha stale' })).toBeNull()
		expect(screen.getByRole('option', { name: 'Beta current' })).toBeTruthy()
	})

	it.each([
		'collection',
		'project',
	])('does not expose old suggestions after a %s switch', async (context) => {
		const old = deferred<{ suggestions: string[] }>()
		apiGet.mockReturnValueOnce(old.promise)
		const onChange = vi.fn()
		const { rerender } = render(
			<TagInput collectionId="collection-a" projectId="project-a" value={[]} onChange={onChange} />,
		)
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alp' } })
		await advance()
		rerender(
			<TagInput
				collectionId={context === 'collection' ? 'collection-b' : 'collection-a'}
				projectId={context === 'project' ? 'project-b' : 'project-a'}
				value={[]}
				onChange={onChange}
			/>,
		)
		await act(async () => {
			old.resolve({ suggestions: ['Alpha private old context'] })
		})
		await advance()
		expect(screen.queryByRole('option', { name: 'Alpha private old context' })).toBeNull()
		expect(onChange).not.toHaveBeenCalled()
	})

	it.each(['failure', 'timeout'])('retains free entry after a lookup %s', async (failure) => {
		if (failure === 'failure') apiGet.mockRejectedValue(new Error('Unavailable'))
		else apiGet.mockReturnValue(new Promise<never>(() => {}))
		const onChange = vi.fn()
		render(<ControlledTags onChange={onChange} />)
		const input = screen.getByRole('combobox') as HTMLInputElement
		fireEvent.change(input, { target: { value: 'My new tag' } })
		await advance(5300)
		expect(input.value).toBe('My new tag')
		fireEvent.keyDown(input, { key: 'Enter' })
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith(['My new tag'])
		expect(input.value).toBe('')
		expect(apiGet).toHaveBeenCalledTimes(1)
	})

	it('does not search or mutate disabled fields', async () => {
		const onChange = vi.fn()
		render(
			<TagInput collectionId="collection-a" value={['Existing']} onChange={onChange} disabled />,
		)
		const input = screen.getByRole('combobox') as HTMLInputElement
		expect(input.disabled).toBe(true)
		fireEvent.change(input, { target: { value: 'Blocked' } })
		fireEvent.keyDown(input, { key: 'Enter' })
		await advance(1000)
		expect(apiGet).not.toHaveBeenCalled()
		expect(onChange).not.toHaveBeenCalled()
	})

	it('cancels a pending debounce on unmount and ignores an in-flight result', async () => {
		const first = render(<TagInput collectionId="collection-a" value={[]} onChange={vi.fn()} />)
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alp' } })
		first.unmount()
		await advance(300)
		expect(apiGet).not.toHaveBeenCalled()
		const pending = deferred<{ suggestions: string[] }>()
		apiGet.mockReturnValueOnce(pending.promise)
		const onChange = vi.fn()
		const second = render(<TagInput collectionId="collection-a" value={[]} onChange={onChange} />)
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bet' } })
		await advance()
		second.unmount()
		await act(async () => {
			pending.resolve({ suggestions: ['Beta'] })
		})
		expect(screen.queryByRole('listbox')).toBeNull()
		expect(onChange).not.toHaveBeenCalled()
	})
})
