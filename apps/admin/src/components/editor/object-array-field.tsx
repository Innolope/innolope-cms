import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { humanizeKey, summarizeValue } from '../../lib/field-summary'
import { Dropdown } from '../dropdown'
import { JsonField } from './json-field'
import { SubformField } from './subform-field'

export interface SubFieldHint {
	name: string
	type?: string
	options?: string[]
	label?: string
	helpText?: string
	hidden?: boolean
	readOnly?: boolean
}

interface ObjectArrayFieldProps {
	value: unknown
	onChange: (next: Array<Record<string, unknown>>) => void
	disabled?: boolean
	/**
	 * Optional schema-side hint about the per-row shape. Used to:
	 *   1. seed an initial row when the value is empty (no JSON-pasting needed);
	 *   2. drive typed editors per sub-field (enum → dropdown);
	 *   3. label, hide or lock sub-fields the way the field designer configured.
	 * Falls back to whatever keys are discovered from existing rows.
	 */
	subFields?: SubFieldHint[]
	/** Sub-key whose value titles a collapsed row. */
	summaryKey?: string
	/** `false` once a preset is confirmed: rows keep exactly the declared keys. */
	allowExtraKeys?: boolean
	/** Active editing locale, for summaries of localized sub-values. */
	locale?: string
}

type Row = Record<string, unknown>

/** Coerce arbitrary stored value into an array of row objects. */
function toRows(value: unknown): Row[] {
	if (!Array.isArray(value)) return []
	return value.map((item) => {
		if (item && typeof item === 'object' && !Array.isArray(item)) return item as Row
		return { value: item }
	})
}

/** Union of keys across all rows, in first-appearance order. */
function deriveKeys(rows: Row[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const row of rows) {
		for (const k of Object.keys(row)) {
			if (!seen.has(k)) {
				seen.add(k)
				out.push(k)
			}
		}
	}
	return out
}

function emptyRow(keys: string[]): Row {
	const r: Row = {}
	for (const k of keys) r[k] = ''
	return r
}

/** A row the editor has not filled in yet — opened, not collapsed to "Empty". */
function isBlankRow(row: Row): boolean {
	return Object.values(row).every((v) => v === '' || v === null || v === undefined)
}

const inputClass =
	'w-full px-2 py-1.5 bg-input border border-border rounded text-xs focus:outline-none focus:border-border-strong disabled:opacity-60'

function Chevron({ open }: { open: boolean }) {
	return (
		<svg
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
		>
			<polyline points="9 18 15 12 9 6" />
		</svg>
	)
}

function SubFieldEditor({
	value,
	onChange,
	disabled,
	hint,
	locale,
}: {
	value: unknown
	onChange: (next: unknown) => void
	disabled?: boolean
	/** Schema-side type hint; an `enum` hint forces a Dropdown regardless of current value. */
	hint?: SubFieldHint
	locale?: string
}) {
	const { t } = useTranslation()
	// Schema-driven enum: render Dropdown even when value is empty/undefined.
	// Otherwise the inference below would fall through to a text input on the
	// first row and the editor never sees the constrained set of options.
	if (hint?.type === 'enum' && Array.isArray(hint.options)) {
		return (
			<Dropdown
				value={String(value ?? '')}
				onChange={(v) => onChange(v)}
				options={hint.options.map((o) => ({ value: o, label: o }))}
				disabled={disabled}
				className="w-full"
			/>
		)
	}
	if (typeof value === 'boolean' || hint?.type === 'boolean') {
		return (
			<label className="flex items-center gap-2 text-xs">
				<input
					type="checkbox"
					checked={!!value}
					disabled={disabled}
					onChange={(e) => onChange(e.target.checked)}
					className="rounded"
				/>
				<span className="text-text-secondary">
					{value ? t('editor.objectArrayField.yes') : t('editor.objectArrayField.no')}
				</span>
			</label>
		)
	}
	if (typeof value === 'number' || hint?.type === 'number') {
		return (
			<input
				type="number"
				value={value === null || value === undefined ? '' : String(value)}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
				className={inputClass}
			/>
		)
	}
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return (
			<SubformField
				value={value}
				onChange={(next) => onChange(next ?? {})}
				disabled={disabled}
				depth={1}
				locale={locale}
			/>
		)
	}
	if (Array.isArray(value)) {
		return <JsonField value={value} onChange={onChange} disabled={disabled} compact />
	}
	// Default: string input (handles strings, null, undefined, empty)
	return (
		<input
			type="text"
			value={value == null ? '' : String(value)}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={inputClass}
		/>
	)
}

/**
 * Structured repeater for arrays of objects (e.g. socialLinks: [{platform, url}, ...]).
 *
 * Rows collapse to a one-line summary ("LinkedIn · linkedin.com/in/…") and open
 * on click, so a long list stays scannable. Sub-field keys come from the
 * schema's hints first, then from the union of keys across existing rows.
 * Empty arrays without hints fall back to a JSON textarea so editors can paste
 * an initial item.
 */
export function ObjectArrayField({
	value,
	onChange,
	disabled,
	subFields,
	summaryKey,
	allowExtraKeys,
	locale,
}: ObjectArrayFieldProps) {
	const { t } = useTranslation()
	const rows = toRows(value)
	// Schema-side hints take precedence: a sub-field declared in the schema
	// should always have a column, even if no row has populated it yet. A locked
	// shape shows only the declared keys; others survive in the row untouched.
	const hintKeys = subFields?.map((s) => s.name) ?? []
	const discoveredKeys = deriveKeys(rows)
	const keys =
		allowExtraKeys === false && hintKeys.length > 0
			? hintKeys
			: [...hintKeys, ...discoveredKeys.filter((k) => !hintKeys.includes(k))]
	const hintByName = new Map<string, SubFieldHint>((subFields ?? []).map((s) => [s.name, s]))
	const visibleKeys = keys.filter((k) => !hintByName.get(k)?.hidden)

	// Open rows, by index. Rows that are blank when the editor opens start open
	// (there is nothing to summarise yet); everything else starts closed. Decided
	// once, so a row does not snap shut as soon as someone types into it.
	const [toggled, setToggled] = useState<Map<number, boolean>>(
		() => new Map(rows.flatMap((row, i) => (isBlankRow(row) ? [[i, true] as const] : []))),
	)
	const isOpen = (i: number) => toggled.get(i) ?? false
	const setOpen = (i: number, open: boolean) => setToggled((prev) => new Map(prev).set(i, open))

	if (rows.length === 0) {
		// No rows yet. If the schema declares sub-fields, render the structured
		// "+ Add" affordance straight away so a new record doesn't drop the
		// editor into raw-JSON mode. Without hints, fall back to JsonField so
		// the editor can still paste an initial item from elsewhere.
		if (hintKeys.length > 0) {
			return (
				<div className="space-y-2">
					{!disabled && (
						<button
							type="button"
							onClick={() => {
								setOpen(0, true)
								onChange([emptyRow(hintKeys)])
							}}
							className="text-xs text-text-muted hover:text-text-secondary transition-colors"
						>
							{t('editor.objectArrayField.addRow')}
						</button>
					)}
				</div>
			)
		}
		return (
			<div className="space-y-2">
				<JsonField
					value={Array.isArray(value) ? value : []}
					onChange={(v) => {
						if (Array.isArray(v)) onChange(v as Row[])
						else if (v == null) onChange([])
					}}
					disabled={disabled}
				/>
				{!disabled && (
					<button
						type="button"
						onClick={() => {
							setOpen(0, true)
							onChange([{}])
						}}
						className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
					>
						{t('editor.objectArrayField.addEmptyRow')}
					</button>
				)}
			</div>
		)
	}

	const updateRow = (i: number, key: string, next: unknown) => {
		const out = rows.map((r, idx) => (idx === i ? { ...r, [key]: next } : r))
		onChange(out)
	}

	/** Keep open/closed state attached to the rows it belongs to as they move. */
	const remapToggled = (map: (index: number) => number | null) => {
		setToggled((prev) => {
			const next = new Map<number, boolean>()
			for (const [index, open] of prev) {
				const moved = map(index)
				if (moved !== null) next.set(moved, open)
			}
			return next
		})
	}

	const removeRow = (i: number) => {
		remapToggled((index) => (index === i ? null : index > i ? index - 1 : index))
		onChange(rows.filter((_, idx) => idx !== i))
	}

	const moveRow = (i: number, delta: -1 | 1) => {
		const j = i + delta
		if (j < 0 || j >= rows.length) return
		const out = [...rows]
		;[out[i], out[j]] = [out[j], out[i]]
		remapToggled((index) => (index === i ? j : index === j ? i : index))
		onChange(out)
	}

	const addRow = () => {
		setOpen(rows.length, true)
		onChange([...rows, emptyRow(keys)])
	}

	const allOpen = rows.every((_, i) => isOpen(i))

	return (
		<div className="space-y-1.5">
			{rows.length > 1 && (
				<div className="flex justify-end">
					<button
						type="button"
						onClick={() => setToggled(new Map(rows.map((_, i) => [i, !allOpen])))}
						className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
					>
						{allOpen
							? t('editor.objectArrayField.collapseAll')
							: t('editor.objectArrayField.expandAll')}
					</button>
				</div>
			)}
			{rows.map((row, i) => {
				const open = isOpen(i)
				const summary = summarizeValue(row, { summaryKey, locale })
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: row identity is positional; objects don't have stable ids.
					<div key={i} className="rounded border border-border bg-surface-alt">
						<div className="flex items-center gap-1 px-2 py-1.5">
							<button
								type="button"
								onClick={() => setOpen(i, !open)}
								aria-expanded={open}
								className="flex flex-1 items-center gap-2 min-w-0 text-left"
							>
								<Chevron open={open} />
								<span className="text-[10px] text-text-muted font-mono shrink-0">#{i + 1}</span>
								<span
									className={`text-xs truncate ${summary ? 'text-text' : 'text-text-muted italic'}`}
								>
									{summary ?? t('editor.objectArrayField.emptyRow')}
								</span>
							</button>
							{!disabled && rows.length > 1 && (
								<>
									<button
										type="button"
										onClick={() => moveRow(i, -1)}
										disabled={i === 0}
										className="px-1 text-text-muted hover:text-text disabled:opacity-30 text-xs leading-none"
										aria-label={t('editor.objectArrayField.moveUp', { index: i + 1 })}
									>
										↑
									</button>
									<button
										type="button"
										onClick={() => moveRow(i, 1)}
										disabled={i === rows.length - 1}
										className="px-1 text-text-muted hover:text-text disabled:opacity-30 text-xs leading-none"
										aria-label={t('editor.objectArrayField.moveDown', { index: i + 1 })}
									>
										↓
									</button>
								</>
							)}
							{!disabled && (
								<button
									type="button"
									onClick={() => removeRow(i)}
									className="px-1 text-text-muted hover:text-danger text-sm leading-none"
									aria-label={t('editor.objectArrayField.removeRow', { index: i + 1 })}
								>
									&times;
								</button>
							)}
						</div>
						{open && (
							<div className="space-y-2 border-t border-border p-2">
								{visibleKeys.map((k) => {
									const hint = hintByName.get(k)
									return (
										<div key={k}>
											<span
												className="block text-[10px] text-text-muted mb-0.5"
												title={hint?.label ? k : undefined}
											>
												{hint?.label || humanizeKey(k)}
											</span>
											<SubFieldEditor
												value={row[k]}
												onChange={(next) => updateRow(i, k, next)}
												disabled={disabled || hint?.readOnly}
												hint={hint}
												locale={locale}
											/>
											{hint?.helpText && (
												<span className="block text-[10px] text-text-muted mt-0.5">
													{hint.helpText}
												</span>
											)}
										</div>
									)
								})}
							</div>
						)}
					</div>
				)
			})}
			{!disabled && (
				<button
					type="button"
					onClick={addRow}
					className="text-xs text-text-muted hover:text-text-secondary transition-colors"
				>
					{t('editor.objectArrayField.addRow')}
				</button>
			)}
		</div>
	)
}
