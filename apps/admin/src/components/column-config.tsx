import { useEffect, useRef, useState } from 'react'

export interface ColumnOption {
	id: string
	label: string
}

interface Props {
	available: ColumnOption[]
	visible: string[]
	pinned: string[]
	onToggle: (id: string) => void
	onMove: (id: string, direction: -1 | 1) => void
	onReset: () => void
}

export function ColumnConfig({ available, visible, pinned, onToggle, onMove, onReset }: Props) {
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [open])

	const visibleSet = new Set(visible)
	const pinnedSet = new Set(pinned)

	// Show visible items first (in current order), then hidden items
	const sorted = [
		...visible.map((id) => available.find((a) => a.id === id)).filter((x): x is ColumnOption => Boolean(x)),
		...available.filter((a) => !visibleSet.has(a.id)),
	]

	return (
		<div className="relative" ref={ref}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 px-3 py-2 bg-input border border-border rounded text-sm text-text hover:border-border-strong focus:outline-none focus:border-border-strong"
				title="Configure columns"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<line x1="3" y1="6" x2="21" y2="6" />
					<line x1="3" y1="12" x2="21" y2="12" />
					<line x1="3" y1="18" x2="21" y2="18" />
				</svg>
				Columns
			</button>

			{open && (
				<div className="absolute right-0 top-full mt-1 w-64 bg-surface border border-border-strong rounded-lg shadow-xl z-50 overflow-hidden">
					<div className="px-3 py-2 border-b border-border text-xs font-medium text-text-secondary uppercase tracking-wide">
						Columns
					</div>
					<div className="max-h-80 overflow-y-auto py-1">
						{sorted.map((col) => {
							const isVisible = visibleSet.has(col.id)
							const isPinned = pinnedSet.has(col.id)
							const visibleIdx = visible.indexOf(col.id)
							const canMoveUp = isVisible && visibleIdx > 0 && !pinnedSet.has(visible[visibleIdx - 1])
							const canMoveDown = isVisible && visibleIdx >= 0 && visibleIdx < visible.length - 1
							return (
								<div key={col.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-alt">
									<input
										type="checkbox"
										checked={isVisible}
										disabled={isPinned}
										onChange={() => onToggle(col.id)}
										className="cursor-pointer"
									/>
									<span className={`flex-1 text-sm ${isVisible ? 'text-text' : 'text-text-secondary'}`}>
										{col.label}
										{isPinned && <span className="ml-1.5 text-[10px] text-text-muted">pinned</span>}
									</span>
									{isVisible && !isPinned && (
										<div className="flex gap-0.5">
											<button
												type="button"
												onClick={() => onMove(col.id, -1)}
												disabled={!canMoveUp}
												className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-text disabled:opacity-20 disabled:cursor-not-allowed"
												title="Move up"
											>
												<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
											</button>
											<button
												type="button"
												onClick={() => onMove(col.id, 1)}
												disabled={!canMoveDown}
												className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-text disabled:opacity-20 disabled:cursor-not-allowed"
												title="Move down"
											>
												<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
											</button>
										</div>
									)}
								</div>
							)
						})}
					</div>
					<div className="px-3 py-2 border-t border-border">
						<button type="button" onClick={onReset} className="text-xs text-text-secondary hover:text-text">
							Reset to default
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
