import { useCollections } from '../../lib/collections'

interface Props {
	/** `null` = unrestricted (full access). Array = scoped to these collection ids. */
	value: string[] | null
	onChange: (next: string[] | null) => void
	/** Hide the picker entirely (e.g. for owner/admin who always have full access). */
	disabled?: boolean
}

/**
 * Two-mode access picker: "All collections" (null) or "Specific collections"
 * (array of ids). The "linked" badge marks collections that are referenced by
 * another collection's relation field — those are auto-readable for picker /
 * resolution purposes even when not explicitly granted, so the inviter only
 * needs to check them when the member should be able to edit them directly.
 */
export function CollectionAccessPicker({ value, onChange, disabled }: Props) {
	const { collections } = useCollections()
	const mode: 'all' | 'specific' = value === null ? 'all' : 'specific'
	const selected = new Set(value ?? [])

	// Hide the media-backed collection — uploads are always permitted regardless
	// of allowlist, so showing it as a togglable option would be misleading.
	const pickable = collections.filter((c) => c.source !== 'media')

	const toggle = (id: string) => {
		const next = new Set(selected)
		if (next.has(id)) next.delete(id)
		else next.add(id)
		onChange(Array.from(next))
	}

	if (disabled) {
		return (
			<p className="text-xs text-text-muted">
				Full access (this role grants access to all collections).
			</p>
		)
	}

	return (
		<div className="space-y-3">
			<div className="flex gap-4 text-sm">
				<label className="flex items-center gap-2 cursor-pointer">
					<input type="radio" checked={mode === 'all'} onChange={() => onChange(null)} />
					<span>All collections</span>
				</label>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="radio"
						checked={mode === 'specific'}
						onChange={() => onChange(value ?? [])}
					/>
					<span>Specific collections</span>
				</label>
			</div>

			{mode === 'specific' && (
				<div className="space-y-2">
					<div className="flex flex-wrap gap-1.5">
						{pickable.map((col) => {
							const active = selected.has(col.id)
							return (
								<button
									key={col.id}
									type="button"
									onClick={() => toggle(col.id)}
									className={`px-2 py-1 rounded text-xs border transition-colors ${
										active
											? 'bg-btn-primary text-btn-primary-text border-btn-primary'
											: 'bg-surface text-text-secondary border-border hover:bg-surface-alt'
									}`}
									title={
										col.isLinkedTarget
											? 'Auto-readable via relations — only grant if the user must edit it directly.'
											: undefined
									}
								>
									{col.label}
									{col.isLinkedTarget && (
										<span className="ml-1 opacity-60 text-[10px] uppercase">linked</span>
									)}
								</button>
							)
						})}
						{pickable.length === 0 && (
							<p className="text-xs text-text-muted">No collections in this project yet.</p>
						)}
					</div>
					<p className="text-xs text-text-muted">
						Linked collections (used as relation targets) are readable automatically through
						relations — grant them only if the user should be able to manage records directly.
					</p>
				</div>
			)}
		</div>
	)
}
