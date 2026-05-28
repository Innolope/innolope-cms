import { useTranslation } from 'react-i18next'
import { Dropdown } from '../dropdown'
import { JsonField } from './json-field'

interface SubFieldHint {
	name: string
	type?: string
	options?: string[]
	label?: string
}

interface ObjectArrayFieldProps {
	value: unknown
	onChange: (next: Array<Record<string, unknown>>) => void
	disabled?: boolean
	/**
	 * Optional schema-side hint about the per-row shape. Used to:
	 *   1. seed an initial row when the value is empty (no JSON-pasting needed);
	 *   2. drive typed editors per sub-field (enum → dropdown).
	 * Falls back to whatever keys are discovered from existing rows.
	 */
	subFields?: SubFieldHint[]
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

const inputClass =
	'w-full px-2 py-1.5 bg-input border border-border rounded text-xs focus:outline-none focus:border-border-strong disabled:opacity-60'

function SubFieldEditor({
	value,
	onChange,
	disabled,
	hint,
}: {
	value: unknown
	onChange: (next: unknown) => void
	disabled?: boolean
	/** Schema-side type hint; an `enum` hint forces a Dropdown regardless of current value. */
	hint?: SubFieldHint
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
	if (typeof value === 'boolean') {
		return (
			<label className="flex items-center gap-2 text-xs">
				<input
					type="checkbox"
					checked={value}
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
	if (typeof value === 'number') {
		return (
			<input
				type="number"
				value={String(value)}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
				className={inputClass}
			/>
		)
	}
	if (value !== null && typeof value === 'object') {
		return (
			<div>
				<span className="block text-[10px] text-text-muted mb-0.5 font-mono italic">
					{t('editor.objectArrayField.nested')}
				</span>
				<JsonField value={value} onChange={onChange} disabled={disabled} compact />
			</div>
		)
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
 * Sub-field keys are discovered from the union of keys across existing rows.
 * Empty arrays fall back to a JSON textarea so editors can paste an initial item.
 */
export function ObjectArrayField({ value, onChange, disabled, subFields }: ObjectArrayFieldProps) {
	const { t } = useTranslation()
	const rows = toRows(value)
	// Schema-side hints take precedence: a sub-field declared in the schema
	// should always have a column, even if no row has populated it yet.
	const hintKeys = subFields?.map((s) => s.name) ?? []
	const discoveredKeys = deriveKeys(rows)
	const keys = [...hintKeys, ...discoveredKeys.filter((k) => !hintKeys.includes(k))]
	const hintByName = new Map<string, SubFieldHint>((subFields ?? []).map((s) => [s.name, s]))

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
							onClick={() => onChange([emptyRow(hintKeys)])}
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
						onClick={() => onChange([{}])}
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

	const removeRow = (i: number) => {
		onChange(rows.filter((_, idx) => idx !== i))
	}

	const addRow = () => {
		onChange([...rows, emptyRow(keys)])
	}

	return (
		<div className="space-y-2">
			{rows.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: row identity is positional; objects don't have stable ids.
				<div key={i} className="rounded border border-border bg-surface-alt p-2 space-y-2">
					<div className="flex items-center justify-between">
						<span className="text-[10px] text-text-muted font-mono">#{i + 1}</span>
						{!disabled && (
							<button
								type="button"
								onClick={() => removeRow(i)}
								className="text-text-muted hover:text-danger text-sm leading-none"
								aria-label={t('editor.objectArrayField.removeRow', { index: i + 1 })}
							>
								&times;
							</button>
						)}
					</div>
					{keys.map((k) => (
						<div key={k}>
							<span className="block text-[10px] text-text-muted mb-0.5 font-mono">{k}</span>
							<SubFieldEditor
								value={row[k]}
								onChange={(next) => updateRow(i, k, next)}
								disabled={disabled}
								hint={hintByName.get(k)}
							/>
						</div>
					))}
				</div>
			))}
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
