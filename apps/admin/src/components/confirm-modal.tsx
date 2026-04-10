interface ConfirmModalProps {
	title: string
	message: string
	confirmLabel?: string
	onConfirm: () => void
	onCancel: () => void
}

export function ConfirmModal({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }: ConfirmModalProps) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
			<div
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-sm p-6"
				onClick={(e) => e.stopPropagation()}
			>
				<h3 className="font-semibold text-text mb-2">{title}</h3>
				<p className="text-sm text-text-secondary mb-6">{message}</p>
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
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	)
}
