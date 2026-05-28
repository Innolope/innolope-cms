/**
 * Auto-exploded form for an `object`-typed schema field.
 *
 * Instead of dropping the user into a raw JSON textarea for nested objects,
 * SubformField walks the value's keys and renders one labelled control per
 * key, inferring the widget from the runtime type of each key's value:
 *
 *   string  → single-line input
 *   text > 60 chars → auto-growing textarea
 *   boolean → checkbox
 *   number  → number input
 *   object  → recurse (nested subform)
 *   array   → JSON fallback (rare in practice, kept simple)
 *
 * For NEW records (empty value) the component renders a small empty-state
 * with an "+ Add field" button — same UX as the schema editor — so users
 * don't have to guess the shape. When the schema field has `ui.subFields`
 * declared, those keys are seeded as empty form rows.
 *
 * The resulting onChange always emits the full nested object so callers
 * (the form save handler) get back the same shape the data was loaded with.
 */

import { useState } from 'react'

interface SubFieldHint {
	name: string
	label?: string
	type?: string
}

interface SubformFieldProps {
	value: unknown
	onChange: (next: Record<string, unknown> | undefined) => void
	disabled?: boolean
	/**
	 * Optional schema for the nested keys. When provided, drives the order +
	 * labels of the rendered rows even on an empty value. Falls back to
	 * `Object.keys(value)` when missing.
	 */
	subFields?: SubFieldHint[]
	/** Nesting depth — controls left margin to make hierarchy visible. */
	depth?: number
}

function humanize(name: string): string {
	// `homeworkAfterLesson` → `Homework after lesson`
	const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/**
 * Best-guess widget for a key whose current value is the given runtime value.
 * Used when `subFields` doesn't declare a `type`.
 */
function inferWidget(v: unknown): 'string' | 'textarea' | 'boolean' | 'number' | 'object' | 'json' {
	if (typeof v === 'boolean') return 'boolean'
	if (typeof v === 'number') return 'number'
	if (typeof v === 'string') return v.length > 60 ? 'textarea' : 'string'
	if (Array.isArray(v)) return 'json'
	if (v && typeof v === 'object') return 'object'
	return 'string'
}

const inputCls =
	'w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60'

export function SubformField({
	value,
	onChange,
	disabled,
	subFields,
	depth = 0,
}: SubformFieldProps) {
	// Coerce to an object — string/null/undefined inputs become {} so the user
	// can start editing without first picking a "shape".
	const obj: Record<string, unknown> =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}

	// Compose the rendered key list: schema-declared keys first (in order),
	// then any keys that exist in the value but aren't in the schema.
	const declared = (subFields ?? []).map((f) => f.name)
	const present = Object.keys(obj)
	const orderedKeys = [...declared, ...present.filter((k) => !declared.includes(k))]

	// Track keys the user added via "+ Add field" so the row appears even
	// before they type any value.
	const [extraKeys, setExtraKeys] = useState<string[]>([])
	const allKeys = [...orderedKeys, ...extraKeys.filter((k) => !orderedKeys.includes(k))]

	const setKey = (k: string, v: unknown) => {
		const next: Record<string, unknown> = { ...obj }
		if (
			v === undefined ||
			v === '' ||
			(typeof v === 'object' && v != null && Object.keys(v).length === 0)
		) {
			delete next[k]
		} else {
			next[k] = v
		}
		onChange(Object.keys(next).length ? next : undefined)
	}

	const removeKey = (k: string) => {
		const next = { ...obj }
		delete next[k]
		setExtraKeys((prev) => prev.filter((x) => x !== k))
		onChange(Object.keys(next).length ? next : undefined)
	}

	const [addingKey, setAddingKey] = useState(false)
	const [draftKey, setDraftKey] = useState('')

	const containerCls =
		depth === 0
			? 'space-y-3 p-3 bg-surface border border-border rounded'
			: 'space-y-3 pl-3 ml-1 border-l border-border'

	return (
		<div className={containerCls}>
			{allKeys.map((k) => {
				const subFieldDef = subFields?.find((f) => f.name === k)
				const label = subFieldDef?.label || humanize(k)
				const v = obj[k]
				const widget =
					(subFieldDef?.type as ReturnType<typeof inferWidget> | undefined) ?? inferWidget(v)

				return (
					<div key={k} className="space-y-1">
						<div className="flex items-baseline justify-between">
							<span className="text-xs text-text-secondary">{label}</span>
							{!disabled && (
								<button
									type="button"
									onClick={() => removeKey(k)}
									className="text-[10px] text-text-muted hover:text-text"
									title="Remove this field"
								>
									remove
								</button>
							)}
						</div>
						{widget === 'boolean' ? (
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={!!v}
									onChange={(e) => setKey(k, e.target.checked)}
									disabled={disabled}
									className="rounded"
								/>
								<span className="text-text-secondary">{v ? 'Yes' : 'No'}</span>
							</label>
						) : widget === 'number' ? (
							<input
								type="number"
								value={String(v ?? '')}
								onChange={(e) => setKey(k, e.target.value ? Number(e.target.value) : undefined)}
								disabled={disabled}
								className={inputCls}
							/>
						) : widget === 'textarea' ? (
							<textarea
								value={String(v ?? '')}
								onChange={(e) => setKey(k, e.target.value || undefined)}
								disabled={disabled}
								rows={3}
								className={`${inputCls} resize-y`}
							/>
						) : widget === 'object' ? (
							<SubformField
								value={v}
								onChange={(nv) => setKey(k, nv)}
								disabled={disabled}
								subFields={subFieldDef ? undefined : undefined}
								depth={depth + 1}
							/>
						) : widget === 'json' ? (
							<textarea
								value={(() => {
									try {
										return JSON.stringify(v ?? null, null, 2)
									} catch {
										return ''
									}
								})()}
								onChange={(e) => {
									try {
										setKey(k, JSON.parse(e.target.value))
									} catch {
										/* keep stale value until JSON parses */
									}
								}}
								disabled={disabled}
								rows={4}
								className={`${inputCls} font-mono text-xs resize-y`}
							/>
						) : (
							<input
								type="text"
								value={String(v ?? '')}
								onChange={(e) => setKey(k, e.target.value || undefined)}
								disabled={disabled}
								className={inputCls}
							/>
						)}
					</div>
				)
			})}

			{/* + Add field — lets the user introduce a new key when the schema
			    doesn't declare one. Hidden when disabled (read-only). */}
			{!disabled &&
				(addingKey ? (
					<div className="flex items-center gap-2">
						<input
							type="text"
							value={draftKey}
							onChange={(e) => setDraftKey(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault()
									const k = draftKey.trim()
									if (k && !allKeys.includes(k)) {
										setExtraKeys((prev) => [...prev, k])
										setDraftKey('')
										setAddingKey(false)
									}
								} else if (e.key === 'Escape') {
									setAddingKey(false)
									setDraftKey('')
								}
							}}
							placeholder="Field name (e.g. shortDescription)"
							className={`flex-1 ${inputCls}`}
							autoFocus
						/>
						<button
							type="button"
							onClick={() => {
								const k = draftKey.trim()
								if (k && !allKeys.includes(k)) {
									setExtraKeys((prev) => [...prev, k])
									setDraftKey('')
									setAddingKey(false)
								}
							}}
							className="px-3 py-1.5 text-xs bg-btn-secondary rounded hover:bg-btn-secondary-hover"
						>
							Add
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setAddingKey(true)}
						className="text-xs text-text-muted hover:text-text"
					>
						+ Add field
					</button>
				))}
		</div>
	)
}
