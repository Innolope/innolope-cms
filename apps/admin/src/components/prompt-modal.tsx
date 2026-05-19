import { useEffect, useId, useState } from 'react'

interface PromptModalProps {
	title: string
	message?: string
	label?: string
	placeholder?: string
	defaultValue?: string
	confirmLabel?: string
	/** When true, the confirm button stays disabled until the field is non-empty. */
	required?: boolean
	/** Renders a textarea instead of a single-line input. */
	multiline?: boolean
	onConfirm: (value: string) => void
	onCancel: () => void
}

export function PromptModal({
	title,
	message,
	label,
	placeholder,
	defaultValue = '',
	confirmLabel = 'Confirm',
	required = false,
	multiline = false,
	onConfirm,
	onCancel,
}: PromptModalProps) {
	const inputId = useId()
	const [value, setValue] = useState(defaultValue)
	const blocked = required && value.trim() === ''

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onCancel()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [onCancel])

	const submit = () => {
		if (!blocked) onConfirm(value)
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<button
				type="button"
				aria-label="Close dialog"
				className="absolute inset-0 -z-10 cursor-default"
				onClick={onCancel}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-sm p-6"
			>
				<h3 className="font-semibold text-text mb-2">{title}</h3>
				{message && <p className="text-sm text-text-secondary mb-4">{message}</p>}
				{label && (
					<label htmlFor={inputId} className="block text-xs text-text-secondary mb-1.5">
						{label}
					</label>
				)}
				{multiline ? (
					<textarea
						id={inputId}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={placeholder}
						rows={3}
						autoFocus
						className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong resize-y mb-6"
					/>
				) : (
					<input
						id={inputId}
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								submit()
							}
						}}
						placeholder={placeholder}
						autoFocus
						className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong mb-6"
					/>
				)}
				<div className="flex gap-3 justify-end">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-2 bg-btn-secondary text-text-secondary rounded-lg text-sm hover:bg-btn-secondary-hover transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={submit}
						disabled={blocked}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors disabled:opacity-40"
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	)
}
