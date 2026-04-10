import { useState } from 'react'
import { ConfirmModal } from './confirm-modal'

interface SaveBarProps {
	dirty: boolean
	saving: boolean
	saved: boolean
	onSave: () => void
	onReset: () => void
	saveLabel?: string
}

export function SaveBar({ dirty, saving, saved, onSave, onReset, saveLabel }: SaveBarProps) {
	const [showConfirm, setShowConfirm] = useState(false)

	if (!dirty && !saving && !saved) return null

	return (
		<>
			{dirty && !saving && (
				<div className="fixed bottom-6 left-[calc(16rem+2rem)] z-40">
					<button
						type="button"
						onClick={() => setShowConfirm(true)}
						className="text-sm text-text-muted underline hover:text-text-secondary transition-colors"
					>
						Reset
					</button>
				</div>
			)}
			<div className="fixed bottom-6 right-6 z-40">
				<button
					type="button"
					onClick={onSave}
					disabled={saving || !dirty}
					className="px-5 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-40 shadow-lg transition-all"
				>
					{saving ? 'Saving...' : saved ? 'Saved' : (saveLabel || 'Save Changes')}
				</button>
			</div>

			{showConfirm && (
				<ConfirmModal
					title="Discard changes?"
					message="Your unsaved changes will be lost. This cannot be undone."
					confirmLabel="Discard"
					onConfirm={() => { setShowConfirm(false); onReset() }}
					onCancel={() => setShowConfirm(false)}
				/>
			)}
		</>
	)
}
