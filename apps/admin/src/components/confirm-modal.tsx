import { useEffect, useId, useState } from 'react'

interface ConfirmModalProps {
	title: string
	message: string
	confirmLabel?: string
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
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-sm p-6"
			>
				<h3 className="font-semibold text-text mb-2">{title}</h3>
				<p className="text-sm text-text-secondary mb-6">{message}</p>
				{requireText !== undefined && (
					<div className="mb-6 -mt-2">
						<label htmlFor={inputId} className="block text-xs text-text-secondary mb-1.5">
							Type <span className="font-mono text-text">{requireText}</span> to confirm
						</label>
						<input
							id={inputId}
							type="text"
							value={typed}
							onChange={(e) => setTyped(e.target.value)}
							placeholder={requireText}
							autoFocus
							className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
						/>
					</div>
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
						onClick={onConfirm}
						disabled={blocked}
						className={
							danger
								? 'px-4 py-2 bg-danger text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40'
								: 'px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors disabled:opacity-40'
						}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	)
}
