import { useState, useRef, useEffect } from 'react'

interface DropdownProps {
	value: string
	onChange: (value: string) => void
	options: { value: string; label: string }[]
	className?: string
	placeholder?: string
}

export function Dropdown({ value, onChange, options, className = '', placeholder }: DropdownProps) {
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

	const selected = options.find((o) => o.value === value)

	return (
		<div className={`relative ${className}`} ref={ref}>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="w-full flex items-center justify-between px-3 py-2.5 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong text-left"
			>
				<span className={selected ? 'text-text' : 'text-text-muted'}>
					{selected?.label || placeholder || 'Select...'}
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
							onClick={() => {
								onChange(opt.value)
								setOpen(false)
							}}
							className={`w-full text-left px-3 py-2 text-sm transition-colors ${
								opt.value === value
									? 'bg-surface-alt text-text font-medium'
									: 'text-text-secondary hover:bg-surface-alt hover:text-text'
							}`}
						>
							{opt.label}
						</button>
					))}
				</div>
			)}
		</div>
	)
}
