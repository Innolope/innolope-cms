import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../../lib/i18n'
import { SyncConflictsDialog } from './sync-conflicts-dialog'

type Props = ComponentProps<typeof SyncConflictsDialog>

const collection = {
	id: 'collection-acceptance',
	fields: [
		{ name: 'title', type: 'text', label: 'Article headline' },
		{ name: 'description', type: 'text', label: 'Description' },
		{ name: 'tags', type: 'tags', label: 'Topic tags' },
		{ name: 'translations', type: 'json', label: 'Translations' },
		{ name: 'optional', type: 'text', label: 'Optional caption' },
		{ name: 'empty', type: 'text', label: 'Empty caption' },
	],
} as Props['collection']

function props(overrides: Partial<Props> = {}): Props {
	return {
		collection,
		defaultLocale: 'en',
		syncing: false,
		onCancel: vi.fn(),
		onConfirm: vi.fn(),
		conflicts: [
			{
				contentId: 'content-acceptance',
				externalId: 'external-acceptance',
				slug: 'article',
				metadata: {},
				token: 'token-before',
				categories: ['content', 'details', 'status'],
				fullComparison: true,
				local: {
					markdown: 'The CMS version ends here.',
					metadata: {
						title: 'CMS headline',
						description: 'Same description',
						tags: ['old tag'],
						translations: { en: { title: 'English before' } },
					},
					status: 'draft',
				},
				external: {
					markdown: 'The external version ends here.',
					metadata: {
						title: 'External headline',
						description: 'Same description',
						tags: ['new tag'],
						translations: { en: { title: 'English after' } },
					},
					status: 'published',
				},
			},
		],
		...overrides,
	}
}

beforeAll(async () => {
	await i18n.changeLanguage('en')
})

describe('conflict comparison independent acceptance', () => {
	it('labels changed schema fields and highlights removed and inserted text', () => {
		const { container } = render(<SyncConflictsDialog {...props()} />)
		expect(screen.getByText('Article headline')).toBeTruthy()
		expect(screen.getByText('Topic tags')).toBeTruthy()
		expect(screen.queryByText('Description')).toBeNull()
		expect(container.textContent).toContain('English')
		expect(container.textContent).not.toContain('translations.en.title')
		expect(
			Array.from(container.querySelectorAll('del'))
				.map((node) => node.textContent)
				.join(' '),
		).toContain('CMS')
		expect(
			Array.from(container.querySelectorAll('mark'))
				.map((node) => node.textContent)
				.join(' '),
		).toContain('external')
		expect(container.textContent?.toLowerCase()).toContain('draft')
		expect(container.textContent?.toLowerCase()).toContain('published')
	})

	it('does not truncate changes beyond character 240 and makes folded context expandable', () => {
		const initial = props()
		const conflict = initial.conflicts[0]
		if (!conflict?.local || !conflict.external) throw new Error('Missing comparison fixture')
		const longContext = Array.from(
			{ length: 100 },
			(_, index) => `Unchanged context line ${index}.`,
		).join('\n')
		const { container } = render(
			<SyncConflictsDialog
				{...initial}
				conflicts={[
					{
						...conflict,
						local: { ...conflict.local, markdown: `${longContext}\nCMS final change` },
						external: { ...conflict.external, markdown: `${longContext}\nExternal final change` },
					},
				]}
			/>,
		)
		expect(container.textContent).toContain('CMS')
		expect(container.textContent).toContain('External')
		expect(
			Array.from(container.querySelectorAll('del'))
				.map((node) => node.textContent)
				.join(' '),
		).toContain('CMS')
		expect(
			Array.from(container.querySelectorAll('mark'))
				.map((node) => node.textContent)
				.join(' '),
		).toContain('External')
		const expand = screen
			.getAllByRole('button')
			.find((button) => /unchanged|context|expand|show.*more/i.test(button.textContent ?? ''))
		expect(expand).toBeTruthy()
		if (!expand) throw new Error('Long unchanged context needs an explicit expansion control')
		fireEvent.click(expand)
		expect(container.textContent).toContain('Unchanged context line 50.')
	})

	it('preserves missing, null and empty differences and escapes markup', () => {
		const initial = props()
		const conflict = initial.conflicts[0]
		if (!conflict?.local || !conflict.external) throw new Error('Missing comparison fixture')
		const attack = '<img src=x onerror="alert(1)">'
		const { container } = render(
			<SyncConflictsDialog
				{...initial}
				conflicts={[
					{
						...conflict,
						local: { ...conflict.local, markdown: 'plain', metadata: { empty: null } },
						external: {
							...conflict.external,
							markdown: attack,
							metadata: { optional: null, empty: '' },
						},
					},
				]}
			/>,
		)
		expect(screen.getByText('Optional caption')).toBeTruthy()
		expect(screen.getByText('Empty caption')).toBeTruthy()
		expect(container.textContent).toContain(attack)
		expect(container.querySelector("img[src='x']")).toBeNull()
		expect(container.querySelector('[onerror]')).toBeNull()
	})

	it('invalidates a prior decision when its conflict token changes', () => {
		const initial = props()
		const { rerender } = render(<SyncConflictsDialog {...initial} />)
		fireEvent.click(screen.getByRole('radio', { name: /Keep CMS edits/i }))
		expect(
			(screen.getByRole('button', { name: /Apply choices/i }) as HTMLButtonElement).disabled,
		).toBe(false)
		rerender(
			<SyncConflictsDialog
				{...initial}
				conflicts={initial.conflicts.map((conflict) => ({ ...conflict, token: 'token-after' }))}
			/>,
		)
		expect(
			(screen.getByRole('button', { name: /Apply choices|Syncing/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true)
		expect(
			(screen.getByRole('radio', { name: /Keep CMS edits/i }) as HTMLInputElement).checked,
		).toBe(false)
		expect(initial.onConfirm).not.toHaveBeenCalled()
	})

	it('keeps the choice but prevents applying it while synchronization is running', () => {
		const initial = props()
		const { rerender } = render(<SyncConflictsDialog {...initial} />)
		fireEvent.click(screen.getByRole('radio', { name: /Use external edits/i }))
		rerender(<SyncConflictsDialog {...initial} syncing />)
		expect(
			(screen.getByRole('button', { name: /Apply choices|Syncing/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true)
		rerender(<SyncConflictsDialog {...initial} syncing={false} />)
		expect(
			(screen.getByRole('radio', { name: /Use external edits/i }) as HTMLInputElement).checked,
		).toBe(true)
		fireEvent.click(screen.getByRole('button', { name: /Apply choices/i }))
		expect(initial.onConfirm).toHaveBeenCalledTimes(1)
	})
})
