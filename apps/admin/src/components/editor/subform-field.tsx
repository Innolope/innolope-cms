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
 *   object  → nested card (collapsed to a one-line summary)
 *   array   → JSON fallback (rare in practice, kept simple)
 *
 * Nesting stays readable for people who don't think in JSON: nested cards are
 * closed by default and show a summary, and anything deeper than two levels
 * opens as a focused view with a breadcrumb instead of indenting further.
 *
 * For NEW records (empty value) the component renders a small empty-state
 * with an "+ Add field" button — same UX as the schema editor — so users
 * don't have to guess the shape. When the schema field has `ui.subFields`
 * declared, those keys are seeded as empty form rows. A confirmed preset sets
 * `allowExtraKeys: false`, which removes "+ Add field" and moves keys the
 * preset does not list into a read-only "Other keys" note instead of dropping them.
 *
 * The resulting onChange always emits the full nested object so callers
 * (the form save handler) get back the same shape the data was loaded with.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { humanizeKey, summarizeValue } from '../../lib/field-summary'
import { isLocaleMap } from '../../lib/locale-value'
import { Dropdown } from '../dropdown'

export interface SubformHint {
	name: string
	label?: string
	type?: string
	options?: string[]
	helpText?: string
	hidden?: boolean
	readOnly?: boolean
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
	subFields?: SubformHint[]
	/** Nesting depth — 0 is the field itself. */
	depth?: number
	/** `false` once a preset is confirmed: only the declared keys are editable. */
	allowExtraKeys?: boolean
	/** Active editing locale, for summaries of localized sub-values. */
	locale?: string
	/**
	 * Open a nested object as a focused view. Supplied by the top-level subform to
	 * everything below it; `path` is relative to the component that calls it.
	 */
	onOpenDeep?: (path: string[]) => void
}

/** Levels rendered inline before a nested object opens as a focused view. */
const MAX_INLINE_DEPTH = 2

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v)
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
	if (isPlainObject(v) && !isLocaleMap(v, [])) return 'object'
	if (isPlainObject(v)) return 'json'
	return 'string'
}

/** Widget for a declared sub-field type, or null to infer from the value. */
function widgetForType(type: string | undefined): ReturnType<typeof inferWidget> | 'enum' | null {
	switch (type) {
		case 'boolean':
			return 'boolean'
		case 'number':
			return 'number'
		case 'object':
			return 'object'
		case 'array':
			return 'json'
		case 'enum':
			return 'enum'
		case 'text':
			return null
		default:
			return null
	}
}

function getIn(value: unknown, path: string[]): unknown {
	let node = value
	for (const key of path) node = isPlainObject(node) ? node[key] : undefined
	return node
}

function setIn(
	value: Record<string, unknown>,
	path: string[],
	next: unknown,
): Record<string, unknown> {
	if (path.length === 0) return (next as Record<string, unknown>) ?? {}
	const [head, ...rest] = path
	const child = isPlainObject(value[head]) ? (value[head] as Record<string, unknown>) : {}
	const out = { ...value }
	if (rest.length === 0) {
		if (next === undefined) delete out[head]
		else out[head] = next
	} else {
		out[head] = setIn(child, rest, next)
	}
	return out
}

const inputCls =
	'w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60'

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

/**
 * The top-level subform owns the focused view: when a deep object is opened it
 * replaces the inline form with that object's own form under a breadcrumb.
 */
export function SubformField(props: SubformFieldProps) {
	const { t } = useTranslation()
	const [focus, setFocus] = useState<string[] | null>(null)
	const depth = props.depth ?? 0
	if (depth > 0 || props.onOpenDeep) return <SubformBody {...props} depth={depth} />

	const root = isPlainObject(props.value) ? props.value : {}
	if (focus && isPlainObject(getIn(root, focus))) {
		return (
			<div className="space-y-3 p-3 bg-surface border border-border rounded">
				<nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Breadcrumb">
					<button
						type="button"
						onClick={() => setFocus(null)}
						className="text-text-muted hover:text-text"
					>
						{t('editor.subformField.top')}
					</button>
					{focus.map((key, i) => (
						<span key={focus.slice(0, i + 1).join('.')} className="flex items-center gap-1">
							<span className="text-text-muted">›</span>
							{i === focus.length - 1 ? (
								<span className="text-text">{humanizeKey(key)}</span>
							) : (
								<button
									type="button"
									onClick={() => setFocus(focus.slice(0, i + 1))}
									className="text-text-muted hover:text-text"
								>
									{humanizeKey(key)}
								</button>
							)}
						</span>
					))}
				</nav>
				<SubformBody
					value={getIn(root, focus)}
					onChange={(next) => props.onChange(setIn(root, focus, next ?? {}))}
					disabled={props.disabled}
					depth={0}
					locale={props.locale}
					onOpenDeep={(path) => setFocus([...focus, ...path])}
					framed={false}
				/>
			</div>
		)
	}
	return <SubformBody {...props} depth={0} onOpenDeep={(path) => setFocus(path)} />
}

function SubformBody({
	value,
	onChange,
	disabled,
	subFields,
	depth = 0,
	allowExtraKeys,
	locale,
	onOpenDeep,
	framed = true,
}: SubformFieldProps & { framed?: boolean }) {
	const { t } = useTranslation()
	// Coerce to an object — string/null/undefined inputs become {} so the user
	// can start editing without first picking a "shape".
	const obj: Record<string, unknown> = isPlainObject(value) ? value : {}

	// Compose the rendered key list: schema-declared keys first (in order),
	// then any keys that exist in the value but aren't in the schema. A locked
	// shape keeps the undeclared ones out of the form (they stay in the value).
	const declared = (subFields ?? []).map((f) => f.name)
	const present = Object.keys(obj)
	const locked = allowExtraKeys === false && declared.length > 0
	const undeclared = present.filter((k) => !declared.includes(k))
	const orderedKeys = locked ? declared : [...declared, ...undeclared]

	// Track keys the user added via "+ Add field" so the row appears even
	// before they type any value.
	const [extraKeys, setExtraKeys] = useState<string[]>([])
	const allKeys = [...orderedKeys, ...extraKeys.filter((k) => !orderedKeys.includes(k))]
	// Nested cards start closed; the user opens the ones they want to edit.
	const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())

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

	const containerCls = !framed
		? 'space-y-3'
		: depth === 0
			? 'space-y-3 p-3 bg-surface border border-border rounded'
			: 'space-y-3'

	const commitDraftKey = () => {
		const k = draftKey.trim()
		if (k && !allKeys.includes(k)) {
			setExtraKeys((prev) => [...prev, k])
			setDraftKey('')
			setAddingKey(false)
		}
	}

	return (
		<div className={containerCls}>
			{allKeys.map((k) => {
				const subFieldDef = subFields?.find((f) => f.name === k)
				if (subFieldDef?.hidden) return null
				const label = subFieldDef?.label || humanizeKey(k)
				const v = obj[k]
				const fieldDisabled = disabled || subFieldDef?.readOnly
				const widget = widgetForType(subFieldDef?.type) ?? inferWidget(v)
				const canRemove = !fieldDisabled && !locked

				if (widget === 'object') {
					const open = openKeys.has(k)
					const summary = summarizeValue(v, { locale })
					const deep = depth + 1 >= MAX_INLINE_DEPTH && onOpenDeep
					return (
						<div key={k} className="rounded border border-border bg-surface-alt">
							<div className="flex items-center gap-1 px-2 py-1.5">
								<button
									type="button"
									onClick={() => {
										if (deep) {
											onOpenDeep([k])
											return
										}
										setOpenKeys((prev) => {
											const next = new Set(prev)
											if (next.has(k)) next.delete(k)
											else next.add(k)
											return next
										})
									}}
									aria-expanded={deep ? undefined : open}
									className="flex flex-1 items-center gap-2 min-w-0 text-left"
								>
									{deep ? (
										<span className="text-text-muted text-xs" aria-hidden="true">
											↗
										</span>
									) : (
										<Chevron open={open} />
									)}
									<span className="text-xs text-text-secondary shrink-0">{label}</span>
									{(!open || deep) && (
										<span
											className={`text-xs truncate ${summary ? 'text-text' : 'text-text-muted italic'}`}
										>
											{summary ?? t('editor.subformField.empty')}
										</span>
									)}
								</button>
								{canRemove && (
									<button
										type="button"
										onClick={() => removeKey(k)}
										className="px-1 text-[10px] text-text-muted hover:text-text"
										title={t('editor.subformField.removeField')}
									>
										{t('editor.subformField.remove')}
									</button>
								)}
							</div>
							{open && !deep && (
								<div className="border-t border-border p-2">
									<SubformBody
										value={v}
										onChange={(nv) => setKey(k, nv)}
										disabled={fieldDisabled}
										depth={depth + 1}
										locale={locale}
										onOpenDeep={onOpenDeep ? (path) => onOpenDeep([k, ...path]) : undefined}
									/>
								</div>
							)}
						</div>
					)
				}

				return (
					<div key={k} className="space-y-1">
						<div className="flex items-baseline justify-between">
							<span
								className="text-xs text-text-secondary"
								title={subFieldDef?.label ? k : undefined}
							>
								{label}
							</span>
							{canRemove && (
								<button
									type="button"
									onClick={() => removeKey(k)}
									className="text-[10px] text-text-muted hover:text-text"
									title={t('editor.subformField.removeField')}
								>
									{t('editor.subformField.remove')}
								</button>
							)}
						</div>
						{widget === 'enum' && Array.isArray(subFieldDef?.options) ? (
							<Dropdown
								value={String(v ?? '')}
								onChange={(nv) => setKey(k, nv || undefined)}
								options={(subFieldDef?.options ?? []).map((o) => ({ value: o, label: o }))}
								disabled={fieldDisabled}
								className="w-full"
							/>
						) : widget === 'boolean' ? (
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={!!v}
									onChange={(e) => setKey(k, e.target.checked)}
									disabled={fieldDisabled}
									className="rounded"
								/>
								<span className="text-text-secondary">
									{v ? t('editor.fieldRenderer.yes') : t('editor.fieldRenderer.no')}
								</span>
							</label>
						) : widget === 'number' ? (
							<input
								type="number"
								value={String(v ?? '')}
								onChange={(e) => setKey(k, e.target.value ? Number(e.target.value) : undefined)}
								disabled={fieldDisabled}
								className={inputCls}
							/>
						) : widget === 'textarea' ? (
							<textarea
								value={String(v ?? '')}
								onChange={(e) => setKey(k, e.target.value || undefined)}
								disabled={fieldDisabled}
								rows={3}
								className={`${inputCls} resize-y`}
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
								disabled={fieldDisabled}
								rows={4}
								className={`${inputCls} font-mono text-xs resize-y`}
							/>
						) : (
							<input
								type="text"
								value={String(v ?? '')}
								onChange={(e) => setKey(k, e.target.value || undefined)}
								disabled={fieldDisabled}
								className={inputCls}
							/>
						)}
						{subFieldDef?.helpText && (
							<span className="block text-xs text-text-muted">{subFieldDef.helpText}</span>
						)}
					</div>
				)
			})}

			{/* Keys a locked shape does not list: kept in the value, shown read-only so
			    nothing disappears silently. */}
			{locked && undeclared.length > 0 && (
				<details className="text-xs">
					<summary className="cursor-pointer text-text-muted hover:text-text-secondary">
						{t('editor.subformField.otherKeys', { count: undeclared.length })}
					</summary>
					<pre className="mt-1 max-h-48 overflow-auto rounded bg-input p-2 font-mono text-[11px] text-text-secondary">
						{JSON.stringify(Object.fromEntries(undeclared.map((k) => [k, obj[k]])), null, 2)}
					</pre>
				</details>
			)}

			{/* + Add field — lets the user introduce a new key when the schema
			    doesn't declare one. Hidden when disabled (read-only) or locked. */}
			{!disabled &&
				!locked &&
				(addingKey ? (
					<div className="flex items-center gap-2">
						<input
							type="text"
							value={draftKey}
							onChange={(e) => setDraftKey(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault()
									commitDraftKey()
								} else if (e.key === 'Escape') {
									setAddingKey(false)
									setDraftKey('')
								}
							}}
							placeholder={t('editor.subformField.newKeyPlaceholder')}
							className={`flex-1 ${inputCls}`}
							autoFocus
						/>
						<button
							type="button"
							onClick={commitDraftKey}
							className="px-3 py-1.5 text-xs bg-btn-secondary rounded hover:bg-btn-secondary-hover"
						>
							{t('editor.subformField.add')}
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setAddingKey(true)}
						className="text-xs text-text-muted hover:text-text"
					>
						{t('editor.subformField.addField')}
					</button>
				))}
		</div>
	)
}
