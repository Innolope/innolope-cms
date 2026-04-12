interface SaveBarProps {
	dirty: boolean
	saving: boolean
	saved: boolean
	onSave: () => void
	onReset?: () => void
	saveLabel?: string
}

export function SaveBar({ dirty, saving, saved, onSave, saveLabel }: SaveBarProps) {
	if (!dirty && !saving && !saved) return null

	return (
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
	)
}
