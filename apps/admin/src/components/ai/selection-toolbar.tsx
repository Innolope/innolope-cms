import { useState, useEffect, useCallback } from 'react'

interface SelectionToolbarProps {
	containerRef: React.RefObject<HTMLElement | null>
	onAction: (action: string, selectedText: string, fieldName: string) => void
	fieldName: string
}

export function SelectionToolbar({ containerRef, onAction, fieldName }: SelectionToolbarProps) {
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
	const [selectedText, setSelectedText] = useState('')

	const handleSelectionChange = useCallback(() => {
		const selection = window.getSelection()
		if (!selection || selection.isCollapsed || !selection.toString().trim()) {
			setPosition(null)
			setSelectedText('')
			return
		}

		// Check if selection is within our container
		const container = containerRef.current
		if (!container) return

		const range = selection.getRangeAt(0)
		const ancestor = range.commonAncestorContainer
		if (!container.contains(ancestor)) {
			setPosition(null)
			return
		}

		const rect = range.getBoundingClientRect()
		const containerRect = container.getBoundingClientRect()

		setPosition({
			x: rect.left + rect.width / 2 - containerRect.left,
			y: rect.top - containerRect.top - 8,
		})
		setSelectedText(selection.toString())
	}, [containerRef])

	useEffect(() => {
		document.addEventListener('selectionchange', handleSelectionChange)
		return () => document.removeEventListener('selectionchange', handleSelectionChange)
	}, [handleSelectionChange])

	if (!position || !selectedText) return null

	return (
		<div
			className="absolute z-50 -translate-x-1/2 -translate-y-full"
			style={{ left: position.x, top: position.y }}
		>
			<div className="flex items-center gap-0.5 bg-surface border border-border-strong rounded-lg shadow-xl px-1 py-1 animate-in fade-in slide-in-from-bottom-1 duration-150">
				<ToolbarButton
					label="✨ AI"
					onClick={() => onAction('custom', selectedText, fieldName)}
				/>
				<Divider />
				<ToolbarButton
					label="Rewrite"
					onClick={() => onAction('rewrite', selectedText, fieldName)}
				/>
				<ToolbarButton
					label="Shorter"
					onClick={() => onAction('shorter', selectedText, fieldName)}
				/>
				<ToolbarButton
					label="Fix"
					onClick={() => onAction('fix-grammar', selectedText, fieldName)}
				/>
				<ToolbarButton
					label="SEO"
					onClick={() => onAction('seo', selectedText, fieldName)}
				/>
			</div>
		</div>
	)
}

function ToolbarButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault()
				onClick()
			}}
			className="px-2 py-1 text-[11px] text-text-muted hover:text-text hover:bg-surface-alt rounded transition-colors whitespace-nowrap"
		>
			{label}
		</button>
	)
}

function Divider() {
	return <div className="w-px h-4 bg-border mx-0.5" />
}
