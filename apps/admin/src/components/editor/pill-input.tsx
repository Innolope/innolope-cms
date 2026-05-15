import { useState } from 'react'

interface PillInputProps {
	value: string[]
	onChange: (value: string[]) => void
	disabled?: boolean
	placeholder?: string
}

/** Text input that turns entries into removable pills on Enter or comma. */
export function PillInput({ value, onChange, disabled, placeholder }: PillInputProps) {
	const [draft, setDraft] = useState('')

	const commit = (raw: string) => {
		const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
		if (parts.length === 0) return
		const next = [...value]
		for (const p of parts) if (!next.includes(p)) next.push(p)
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
					if (e.key === 'Enter' || e.key === ',') {
						e.preventDefault()
						commit(draft)
					} else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
						removeAt(value.length - 1)
					}
				}}
				onBlur={() => { if (draft.trim()) commit(draft) }}
				className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60"
			/>
			{value.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mt-2">
					{value.map((item, i) => (
						<span
							key={`${item}-${i}`}
							className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-alt text-text-secondary text-xs"
						>
							{item}
							{!disabled && (
								<button
									type="button"
									onClick={() => removeAt(i)}
									className="text-text-muted hover:text-text leading-none text-sm"
									aria-label={`Remove ${item}`}
								>
									&times;
								</button>
							)}
						</span>
					))}
				</div>
			)}
		</div>
	)
}
