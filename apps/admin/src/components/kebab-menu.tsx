import { useEffect, useRef, useState } from 'react'

/**
 * Vertical-dots kebab menu. Click the ⋮ trigger → a small popover opens with
 * a vertical list of actions. Items can be marked `danger` (rendered in red);
 * the menu closes itself after an action is invoked.
 *
 * Replaces the "always-visible red Remove button + greyed-out …" pattern that
 * made every row feel cluttered and treated deletion as a primary action.
 */
export interface KebabMenuItem {
	label: string
	onClick: () => void
	danger?: boolean
	disabled?: boolean
}

interface KebabMenuProps {
	items: KebabMenuItem[]
	/** Where the popover anchors relative to the trigger. Default 'right'. */
	align?: 'left' | 'right'
	/** Aria label for the trigger button. Default 'Open menu'. */
	label?: string
}

export function KebabMenu({ items, align = 'right', label = 'Open menu' }: KebabMenuProps) {
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

	return (
		<div className="relative" ref={ref}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-label={label}
				aria-expanded={open}
				className="flex items-center justify-center w-7 h-7 rounded text-text-muted hover:text-text hover:bg-surface-alt transition-colors"
			>
				{/* ⋮ — three vertical dots, drawn as SVG so it scales crisply */}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<circle cx="12" cy="5" r="1.6" />
					<circle cx="12" cy="12" r="1.6" />
					<circle cx="12" cy="19" r="1.6" />
				</svg>
			</button>
			{open && (
				<div
					className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} min-w-[10rem] bg-surface border border-border-strong rounded-lg shadow-xl z-50 overflow-hidden`}
				>
					{items.map((item) => (
						<button
							key={item.label}
							type="button"
							disabled={item.disabled}
							onClick={() => {
								if (item.disabled) return
								setOpen(false)
								item.onClick()
							}}
							className={`w-full text-left px-3 py-2 text-sm transition-colors whitespace-nowrap ${
								item.disabled
									? 'text-text-muted/50 cursor-not-allowed'
									: item.danger
										? 'text-danger hover:bg-surface-alt'
										: 'text-text-secondary hover:bg-surface-alt hover:text-text'
							}`}
						>
							{item.label}
						</button>
					))}
				</div>
			)}
		</div>
	)
}
