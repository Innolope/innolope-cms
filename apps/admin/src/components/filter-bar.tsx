import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FilterMap, FilterValue } from '../lib/use-url-filters'

export type FilterDescriptor =
	| { id: string; label: string; type: 'enum'; options: { value: string; label: string }[] }
	| { id: string; label: string; type: 'text' }
	| { id: string; label: string; type: 'date-range' }

interface Props {
	available: FilterDescriptor[]
	filters: FilterMap
	onChange: (id: string, value: FilterValue | undefined) => void
	onClearAll: () => void
}

export function FilterBar({ available, filters, onChange, onClearAll }: Props) {
	const { t } = useTranslation()
	const [pickerOpen, setPickerOpen] = useState(false)
	const [editing, setEditing] = useState<string | null>(null) // chip currently being edited
	// Filters that have been added from the picker but don't yet have a value.
	// Empty values aren't persisted to the URL, so we keep their chips alive here
	// until the user either picks a value or closes the editor.
	const [pending, setPending] = useState<string[]>([])
	const pickerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!pickerOpen) return
		const handler = (e: MouseEvent) => {
			if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [pickerOpen])

	const filterIds = Object.keys(filters)
	const activeIds = [...filterIds, ...pending.filter((id) => !filterIds.includes(id))]
	const inactive = available.filter((f) => !activeIds.includes(f.id))

	const addFilter = (id: string) => {
		// Show the chip + open its editor immediately. The value stays empty
		// (and unpersisted) until the user picks one, so track it in `pending`.
		const desc = available.find((d) => d.id === id)
		if (!desc) return
		setPending((p) => (p.includes(id) ? p : [...p, id]))
		setEditing(id)
		setPickerOpen(false)
	}

	return (
		<div className="flex items-center flex-wrap gap-2">
			{activeIds.map((id) => {
				const desc = available.find((d) => d.id === id)
				if (!desc) return null
				const value: FilterValue = filters[id] ?? (desc.type === 'date-range' ? {} : '')
				return (
					<FilterChip
						key={id}
						desc={desc}
						value={value}
						isEditing={editing === id}
						onOpen={() => setEditing(id)}
						onClose={() => {
							setEditing(null)
							// Discard the chip if the user closed it without picking a value.
							if (filters[id] === undefined) setPending((p) => p.filter((x) => x !== id))
						}}
						onChange={(v) => onChange(id, v)}
						onRemove={() => {
							onChange(id, undefined)
							setEditing(null)
							setPending((p) => p.filter((x) => x !== id))
						}}
					/>
				)
			})}

			<div className="relative" ref={pickerRef}>
				<button
					type="button"
					onClick={() => setPickerOpen(!pickerOpen)}
					disabled={inactive.length === 0}
					className="flex items-center gap-1 px-2.5 py-1.5 text-sm text-text-secondary border border-dashed border-border-strong rounded hover:bg-surface-alt hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
				>
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
					{t('filterBar.addFilter')}
				</button>
				{pickerOpen && inactive.length > 0 && (
					<div className="absolute left-0 top-full mt-1 w-48 bg-surface border border-border-strong rounded-lg shadow-xl z-50 overflow-hidden py-1">
						{inactive.map((d) => (
							<button
								key={d.id}
								type="button"
								onClick={() => addFilter(d.id)}
								className="w-full text-left px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-alt hover:text-text"
							>
								{d.label}
							</button>
						))}
					</div>
				)}
			</div>

			{activeIds.length > 0 && (
				<button
					type="button"
					onClick={() => {
						onClearAll()
						setPending([])
						setEditing(null)
					}}
					className="text-xs text-text-muted hover:text-text px-1"
				>
					{t('filterBar.clearAll')}
				</button>
			)}
		</div>
	)
}

interface ChipProps {
	desc: FilterDescriptor
	value: FilterValue
	isEditing: boolean
	onOpen: () => void
	onClose: () => void
	onChange: (v: FilterValue) => void
	onRemove: () => void
}

function FilterChip({ desc, value, isEditing, onOpen, onClose, onChange, onRemove }: ChipProps) {
	const { t } = useTranslation()
	const ref = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!isEditing) return
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose()
		}
		document.addEventListener('mousedown', handler)
		return () => document.removeEventListener('mousedown', handler)
	}, [isEditing, onClose])

	const display = formatValue(desc, value)

	return (
		<div className="relative" ref={ref}>
			<div className="flex items-stretch bg-surface-alt border border-border rounded text-sm overflow-hidden">
				<button
					type="button"
					onClick={onOpen}
					className="px-2 py-1 hover:bg-border/50 flex items-center gap-1.5"
				>
					<span className="text-text-secondary">{desc.label}</span>
					<span className="text-text font-medium">{display}</span>
				</button>
				<button
					type="button"
					onClick={onRemove}
					className="px-1.5 border-l border-border text-text-muted hover:text-text hover:bg-border/50"
					title={t('filterBar.removeFilter')}
				>
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>

			{isEditing && (
				<div className="absolute left-0 top-full mt-1 min-w-[220px] bg-surface border border-border-strong rounded-lg shadow-xl z-50 p-2">
					<FilterEditor desc={desc} value={value} onChange={onChange} />
				</div>
			)}
		</div>
	)
}

function FilterEditor({
	desc,
	value,
	onChange,
}: {
	desc: FilterDescriptor
	value: FilterValue
	onChange: (v: FilterValue) => void
}) {
	const { t } = useTranslation()
	if (desc.type === 'enum') {
		return (
			<div className="max-h-60 overflow-y-auto">
				{desc.options.map((opt) => (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						className={`w-full text-left px-2 py-1.5 text-sm rounded ${
							value === opt.value
								? 'bg-surface-alt text-text font-medium'
								: 'text-text-secondary hover:bg-surface-alt hover:text-text'
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>
		)
	}
	if (desc.type === 'text') {
		return (
			<input
				type="text"
				autoFocus
				value={typeof value === 'string' ? value : ''}
				onChange={(e) => onChange(e.target.value)}
				placeholder={t('filterBar.filterByPlaceholder', { label: desc.label.toLowerCase() })}
				className="w-full px-2 py-1.5 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
			/>
		)
	}
	const range = typeof value === 'object' ? value : {}
	return (
		<div className="flex flex-col gap-2">
			<label className="flex items-center gap-2 text-xs text-text-secondary">
				<span className="w-10">{t('filterBar.from')}</span>
				<input
					type="date"
					value={range.from || ''}
					onChange={(e) => onChange({ ...range, from: e.target.value })}
					className="flex-1 px-2 py-1 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
				/>
			</label>
			<label className="flex items-center gap-2 text-xs text-text-secondary">
				<span className="w-10">{t('filterBar.to')}</span>
				<input
					type="date"
					value={range.to || ''}
					onChange={(e) => onChange({ ...range, to: e.target.value })}
					className="flex-1 px-2 py-1 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong"
				/>
			</label>
		</div>
	)
}

function formatValue(desc: FilterDescriptor, value: FilterValue): string {
	if (desc.type === 'enum') {
		const opt = desc.options.find((o) => o.value === value)
		return opt?.label || (typeof value === 'string' && value ? value : '—')
	}
	if (desc.type === 'text') {
		return typeof value === 'string' && value ? value : '—'
	}
	const range = typeof value === 'object' ? value : {}
	if (range.from && range.to) return `${range.from} → ${range.to}`
	if (range.from) return `≥ ${range.from}`
	if (range.to) return `≤ ${range.to}`
	return '—'
}
