import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface DropdownProps {
	value: string
	onChange: (value: string) => void
	options: { value: string; label: string; disabled?: boolean }[]
	className?: string
	placeholder?: string
	disabled?: boolean
	/**
	 * Optional. When provided, the dropdown renders a trailing row that lets
	 * the user mint a new option inline. The handler is responsible for the
	 * side-effect (e.g. PATCHing the collection to append the new option) and
	 * must resolve before the row closes. The newly-added value is then
	 * selected automatically.
	 *
	 * Callers permission-gate this — non-editors should not be passed an
	 * `onAddOption`.
	 */
	onAddOption?: (newValue: string) => Promise<void> | void
	/** Custom label for the add-option row. Defaults to "+ Add option…". */
	addOptionLabel?: string
}

export function Dropdown({
	value,
	onChange,
	options,
	className = '',
	placeholder,
	disabled = false,
	onAddOption,
	addOptionLabel,
}: DropdownProps) {
	const { t } = useTranslation()
	const resolvedAddOptionLabel = addOptionLabel ?? t('dropdown.addOption')
	const [open, setOpen] = useState(false)
	const [adding, setAdding] = useState(false)
	const [draft, setDraft] = useState('')
	const [saving, setSaving] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const draftInputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false)
				setAdding(false)
				setDraft('')
			}
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [open])

	// Focus the draft input when the user opens the add-option row.
	useEffect(() => {
		if (adding) draftInputRef.current?.focus()
	}, [adding])

	const selected = options.find((o) => o.value === value)

	const submitNewOption = async () => {
		if (!onAddOption || saving) return
		const trimmed = draft.trim()
		if (!trimmed) return
		// If the user typed an already-existing option, just select it.
		const existing = options.find((o) => o.value === trimmed || o.label === trimmed)
		if (existing) {
			onChange(existing.value)
			setAdding(false)
			setDraft('')
			setOpen(false)
			return
		}
		setSaving(true)
		try {
			await onAddOption(trimmed)
			onChange(trimmed)
			setAdding(false)
			setDraft('')
			setOpen(false)
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className={`relative ${className}`} ref={ref}>
			<button
				type="button"
				disabled={disabled}
				onClick={() => setOpen(!open)}
				className="w-full flex items-center justify-between px-3 py-2 bg-input border border-border rounded text-sm text-text focus:outline-none focus:border-border-strong text-left disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<span
					className={`truncate whitespace-nowrap ${selected ? 'text-text' : 'text-text-muted'}`}
				>
					{selected?.label || placeholder || t('dropdown.selectPlaceholder')}
				</span>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className={`text-text-muted shrink-0 ml-2 transition-transform ${open ? 'rotate-180' : ''}`}
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>

			{open && (
				<div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-border-strong rounded-lg shadow-xl z-50 overflow-hidden max-h-60 overflow-y-auto">
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							disabled={opt.disabled}
							onClick={() => {
								if (opt.disabled) return
								onChange(opt.value)
								setOpen(false)
							}}
							className={`w-full text-left px-3 py-2 text-sm transition-colors ${
								opt.disabled
									? 'text-text-muted/50 cursor-not-allowed bg-transparent'
									: opt.value === value
										? 'bg-surface-alt text-text font-medium'
										: 'text-text-secondary hover:bg-surface-alt hover:text-text'
							}`}
						>
							{opt.label}
						</button>
					))}
					{onAddOption &&
						(adding ? (
							<div className="flex items-center gap-1 px-2 py-1.5 border-t border-border sticky bottom-0 bg-surface">
								<input
									ref={draftInputRef}
									type="text"
									value={draft}
									disabled={saving}
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault()
											submitNewOption()
										} else if (e.key === 'Escape') {
											e.preventDefault()
											setAdding(false)
											setDraft('')
										}
									}}
									placeholder={t('dropdown.newOptionPlaceholder')}
									className="flex-1 px-2 py-1 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
								/>
								<button
									type="button"
									onClick={submitNewOption}
									disabled={saving || !draft.trim()}
									className="px-2 py-1 text-xs bg-btn-primary text-btn-primary-text rounded hover:opacity-90 disabled:opacity-40"
								>
									{saving ? t('dropdown.adding') : t('dropdown.add')}
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setAdding(true)}
								className="w-full text-left px-3 py-2 text-sm font-medium text-text hover:bg-surface-alt border-t border-border sticky bottom-0 bg-surface"
							>
								{resolvedAddOptionLabel}
							</button>
						))}
				</div>
			)}
		</div>
	)
}
