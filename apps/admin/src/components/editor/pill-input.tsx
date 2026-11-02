import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** When this many separator characters get added to commit. Default is Enter-only. */
export type PillSeparator = 'enter' | 'comma' | 'both'

interface PillInputProps {
	value: string[]
	onChange: (value: string[]) => void
	disabled?: boolean
	placeholder?: string
	/**
	 * What triggers committing a pill from the draft input.
	 *  - 'enter' (default): only Enter commits. Commas stay in the value — safe
	 *    for labels like "Handling stereotypes, biases, hallucination".
	 *  - 'comma': Enter or comma commit. Faster bulk entry for tag-like fields.
	 *  - 'both': alias for 'comma'.
	 */
	separator?: PillSeparator
	suggestions?: string[]
	onDraftChange?: (value: string) => void
}

/** Text input that turns entries into removable pills. */
export function PillInput({
	value,
	onChange,
	disabled,
	placeholder,
	separator = 'enter',
	suggestions = [],
	onDraftChange,
}: PillInputProps) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState('')
	const [activeIndex, setActiveIndex] = useState(-1)
	const [dismissed, setDismissed] = useState(false)
	const listId = useId()
	const expanded = !disabled && !dismissed && suggestions.length > 0
	const autocompleteProps = onDraftChange
		? {
				role: 'combobox' as const,
				'aria-autocomplete': 'list' as const,
				'aria-expanded': expanded,
				'aria-controls': expanded ? listId : undefined,
				'aria-activedescendant':
					expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined,
			}
		: {}
	const setText = (text: string) => {
		setDraft(text)
		onDraftChange?.(text)
		setActiveIndex(-1)
		setDismissed(false)
	}
	const splitsOnComma = separator !== 'enter'

	const commit = (raw: string) => {
		if (disabled) return
		const parts = splitsOnComma ? raw.split(',') : [raw]
		const cleaned = parts.map((p) => p.trim()).filter(Boolean)
		if (cleaned.length === 0) return
		const next = [...value]
		for (const p of cleaned) if (!next.includes(p)) next.push(p)
		onChange(next)
		setText('')
	}

	const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i))

	return (
		<div className="relative">
			<input
				type="text"
				{...autocompleteProps}
				value={draft}
				disabled={disabled}
				placeholder={placeholder || t('editor.pillInput.placeholder')}
				onChange={(e) => {
					if (!disabled) setText(e.target.value)
				}}
				onKeyDown={(e) => {
					if (disabled || e.nativeEvent.isComposing) return
					if (expanded && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
						e.preventDefault()
						setActiveIndex((index) =>
							e.key === 'ArrowDown'
								? (index + 1) % suggestions.length
								: index <= 0
									? suggestions.length - 1
									: (index - 1) % suggestions.length,
						)
						return
					}
					if (e.key === 'Escape' && expanded) {
						e.preventDefault()
						e.stopPropagation()
						setDismissed(true)
						setActiveIndex(-1)
						return
					}
					if (e.key === 'Enter' && expanded && activeIndex >= 0 && suggestions[activeIndex]) {
						e.preventDefault()
						commit(suggestions[activeIndex])
						return
					}
					if (e.key === 'Enter' || (splitsOnComma && e.key === ',')) {
						e.preventDefault()
						commit(draft)
					} else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
						removeAt(value.length - 1)
					}
				}}
				onBlur={() => {
					if (draft.trim()) commit(draft)
				}}
				className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60"
			/>
			{expanded && (
				<div
					id={listId}
					role="listbox"
					aria-label={t('editor.pillInput.suggestions')}
					className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-auto rounded border border-border bg-surface shadow-lg"
				>
					{suggestions.map((suggestion, index) => (
						<button
							key={suggestion}
							id={`${listId}-${index}`}
							type="button"
							role="option"
							aria-selected={index === activeIndex}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => commit(suggestion)}
							className={`block w-full px-3 py-2 text-left text-sm hover:bg-surface-alt ${index === activeIndex ? 'bg-surface-alt' : ''}`}
						>
							{suggestion}
						</button>
					))}
				</div>
			)}
			{value.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mt-2">
					{value.map((item, i) => {
						// Defensive: callers should pass string[], but if a non-string slips through
						// (e.g. an object), render it as JSON rather than the literal "[object Object]".
						const label = typeof item === 'string' ? item : JSON.stringify(item)
						return (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: pill labels can repeat; index is the stable identity here.
								key={`${i}-${label}`}
								className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-alt text-text-secondary text-xs"
							>
								{label}
								{!disabled && (
									<button
										type="button"
										onClick={() => removeAt(i)}
										className="text-text-muted hover:text-text leading-none text-sm"
										aria-label={t('editor.pillInput.remove', { label })}
									>
										&times;
									</button>
								)}
							</span>
						)
					})}
				</div>
			)}
		</div>
	)
}
