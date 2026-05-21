import { useEffect, useId, useState } from 'react'

interface ConfirmModalProps {
	title: string
	message: string
	confirmLabel?: string
	/** Override the default "Cancel" label (e.g. "Not now", "Later"). */
	cancelLabel?: string
	/**
	 * When true, the cancel control renders as an unobtrusive underlined link at the
	 * bottom-left of the modal instead of a button next to the confirm. Use this for
	 * soft "you can ignore this" prompts (e.g. "Not now") where the visual hierarchy
	 * should push the user toward the confirm action.
	 */
	cancelAsLink?: boolean
	/** Styles the confirm button as destructive (red). */
	danger?: boolean
	/** When set, the user must type this exact value before the confirm button enables. */
	requireText?: string
	onConfirm: () => void
	onCancel: () => void
}

export function ConfirmModal({
	title,
	message,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	cancelAsLink = false,
	danger = false,
	requireText,
	onConfirm,
	onCancel,
}: ConfirmModalProps) {
	const inputId = useId()
	const [typed, setTyped] = useState('')
	const blocked = requireText !== undefined && typed !== requireText

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onCancel()
		}
		document.addEventListener('keydown', onKeyDown)
		return () => document.removeEventListener('keydown', onKeyDown)
	}, [onCancel])

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
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg p-8"
			>
				<h3 className="text-lg font-semibold text-text mb-3">{title}</h3>
				<p className="text-sm text-text-secondary leading-relaxed mb-8">{message}</p>
				{requireText !== undefined && (
					<div className="mb-8 -mt-2">
						<label htmlFor={inputId} className="block text-xs text-text-secondary mb-2">
							Type <span className="font-mono text-text">{requireText}</span> to confirm
						</label>
						<input
							id={inputId}
							type="text"
							value={typed}
							onChange={(e) => setTyped(e.target.value)}
							placeholder={requireText}
							autoFocus
							className="w-full px-3 py-2.5 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
						/>
					</div>
				)}
				<div
					className={`flex gap-3 items-center ${cancelAsLink ? 'justify-between' : 'justify-end'}`}
				>
					{cancelAsLink ? (
						<button
							type="button"
							onClick={onCancel}
							className="text-sm text-text-muted underline underline-offset-2 hover:text-text transition-colors"
						>
							{cancelLabel}
						</button>
					) : (
						<button
							type="button"
							onClick={onCancel}
							className="px-5 py-2.5 bg-btn-secondary text-text-secondary rounded-lg text-sm hover:bg-btn-secondary-hover transition-colors"
						>
							{cancelLabel}
						</button>
					)}
					<button
						type="button"
						onClick={onConfirm}
						disabled={blocked}
						className={
							danger
								? 'px-5 py-2.5 bg-danger text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40'
								: 'px-5 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors disabled:opacity-40'
						}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	)
}
