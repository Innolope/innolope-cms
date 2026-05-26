import { useState } from 'react'

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
}

/** Text input that turns entries into removable pills. */
export function PillInput({
	value,
	onChange,
	disabled,
	placeholder,
	separator = 'enter',
}: PillInputProps) {
	const [draft, setDraft] = useState('')
	const splitsOnComma = separator !== 'enter'

	const commit = (raw: string) => {
		const parts = splitsOnComma ? raw.split(',') : [raw]
		const cleaned = parts.map((p) => p.trim()).filter(Boolean)
		if (cleaned.length === 0) return
		const next = [...value]
		for (const p of cleaned) if (!next.includes(p)) next.push(p)
		onChange(next)
		setDraft('')
	}

	const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i))

	return (
		<div>
			<input
				type="text"
				value={draft}
				disabled={disabled}
				placeholder={placeholder || 'Type and press Enter'}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
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
										aria-label={`Remove ${label}`}
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
