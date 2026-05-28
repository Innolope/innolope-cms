/**
 * Centralized widget dispatch for schema-driven form fields.
 *
 * Replaces the giant inline `renderSchemaField` switch that used to live in
 * `routes/collections.$slug.$contentId.tsx`. Pulling it out has three wins:
 *
 *   1. Every widget honors the same `ui` blob (placeholder, readOnly, helpText,
 *      separator, etc.) instead of just the text branch.
 *   2. New widgets (M3 future widgets like `currency`, `switch`, `range`) plug
 *      into one place.
 *   3. The route file shrinks by ~150 lines and becomes easier to read.
 *
 * The renderer is a pure presentation component — it owns no state, just
 * forwards `value`/`onChange` and uses the field's `ui.widget` (or the smart
 * default per type) to pick the input UI.
 */

import type { CollectionField } from '@innolope/config'
import { useTranslation } from 'react-i18next'
import { Dropdown } from '../dropdown'
import { JsonField } from './json-field'
import { LocalizedTextField } from './localized-text-field'
import { ObjectArrayField } from './object-array-field'
import { PillInput } from './pill-input'
import { RelationField } from './relation-field'
import { SubformField } from './subform-field'

/** Normalize a stored value (array or comma string) to a string array. */
function toStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
	if (typeof v === 'string' && v.trim())
		return v
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	return []
}

/** Normalize a stored date value to a `yyyy-mm-dd` string for <input type="date">. */
function toDateInputValue(v: unknown): string {
	if (!v) return ''
	const d = new Date(v as string)
	return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** True iff value is an array containing at least one non-string, non-null object element. */
function isObjectArray(value: unknown): boolean {
	if (!Array.isArray(value)) return false
	return value.some((item) => item !== null && typeof item === 'object')
}

export interface LocaleRenderCtx {
	mode: 'single' | 'compare'
	activeLocale: string
	leftLocale: string
	rightLocale: string
	defaultLocale: string
}

export interface FieldRendererProps {
	field: CollectionField
	value: unknown
	onChange: (value: unknown) => void
	/** True when the field should render disabled — combines parent + field.ui.readOnly. */
	disabled?: boolean

	// --- Localized text support (only consulted for localized fields) ---
	localized?: boolean
	locale?: LocaleRenderCtx
	onTranslate?: (sourceLocale: string, targetLocale: string) => void
	translating?: boolean

	/**
	 * Optional inline "+ Add option…" handler for enum widgets. When provided,
	 * the Dropdown renders an extra row at the bottom that lets the user mint
	 * a new option without leaving the form. Callers gate this on schema-edit
	 * permission.
	 */
	onAddEnumOption?: (newValue: string) => Promise<void> | void
}

/**
 * Effective widget id for a field — caller's override or the smart default.
 * Kept exported so the schema editor can stay in sync with the runtime.
 */
export function defaultWidgetFor(field: CollectionField): string {
	const w = field.ui?.widget
	if (w) return w
	switch (field.type) {
		case 'text':
			return field.localized ? 'localized' : 'input'
		case 'number':
			return 'input'
		case 'boolean':
			return 'checkbox'
		case 'date':
			return 'date'
		case 'enum':
			return 'dropdown'
		case 'array':
			return 'chips'
		case 'object':
			// Default to a structured subform — raw JSON in the UI is opt-in via
			// ui.widget = 'json'. Localized text objects (`{en, ua}` shapes) take
			// precedence over both.
			return field.localized ? 'localized' : 'subform'
		case 'relation':
			return 'picker'
		default:
			return 'input'
	}
}

export function FieldRenderer({
	field: f,
	value,
	onChange,
	disabled,
	localized,
	locale,
	onTranslate,
	translating,
	onAddEnumOption,
}: FieldRendererProps) {
	const { t } = useTranslation()
	const ro = !!disabled
	const placeholder = f.ui?.placeholder
	const widget = defaultWidgetFor(f)
	const inputCls =
		'w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60'

	// `boolean` ────────────────────────────────────────────────────────────────
	if (f.type === 'boolean') {
		return (
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={!!(value ?? false)}
					onChange={(e) => onChange(e.target.checked)}
					disabled={ro}
					className="rounded"
				/>
				<span className="text-text-secondary">
					{value ? t('editor.fieldRenderer.yes') : t('editor.fieldRenderer.no')}
				</span>
			</label>
		)
	}

	// `number` ─────────────────────────────────────────────────────────────────
	if (f.type === 'number') {
		return (
			<input
				type="number"
				value={String(value ?? '')}
				onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
				disabled={ro}
				placeholder={placeholder}
				className={inputCls}
			/>
		)
	}

	// `date` ───────────────────────────────────────────────────────────────────
	if (f.type === 'date') {
		return (
			<input
				type="date"
				value={toDateInputValue(value)}
				onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
				disabled={ro}
				className={inputCls}
			/>
		)
	}

	// `relation` ───────────────────────────────────────────────────────────────
	if (f.type === 'relation') {
		return (
			<RelationField
				value={String(value ?? '')}
				relationTo={f.relationTo}
				disabled={ro}
				onChange={(v) => onChange(v)}
			/>
		)
	}

	// `object` ─────────────────────────────────────────────────────────────────
	if (f.type === 'object') {
		if (localized && locale) {
			return (
				<LocalizedTextField
					value={value}
					mode={locale.mode}
					activeLocale={locale.activeLocale}
					leftLocale={locale.leftLocale}
					rightLocale={locale.rightLocale}
					defaultLocale={locale.defaultLocale}
					onTranslate={onTranslate}
					translating={translating}
					onChange={(v) => onChange(v)}
					disabled={ro}
					multiline={f.ui?.widget === 'textarea'}
				/>
			)
		}
		// Opt-in raw JSON. Default is the structured subform — splits the value
		// into a labelled control per key so editors never see JSON syntax.
		if (widget === 'json') {
			return <JsonField value={value} onChange={(v) => onChange(v)} disabled={ro} />
		}
		return (
			<SubformField
				value={value}
				onChange={(v) => onChange(v)}
				disabled={ro}
				subFields={f.ui?.subFields?.map((sf) => ({
					name: sf.name,
					label: sf.label,
					type: sf.type,
				}))}
			/>
		)
	}

	// `array` ──────────────────────────────────────────────────────────────────
	if (f.type === 'array') {
		// Schema declared a row shape (`ui.subFields`) → always use the structured
		// repeater so new records still get the right widget. Without subFields, fall
		// back to the value-based heuristic so legacy arrays keep their old UI.
		const declaredSubFields = f.ui?.subFields
		if ((declaredSubFields && declaredSubFields.length > 0) || isObjectArray(value)) {
			return (
				<ObjectArrayField
					value={value}
					onChange={(v) => onChange(v)}
					disabled={ro}
					subFields={declaredSubFields?.map((sf) => ({
						name: sf.name,
						type: sf.type,
						label: sf.label,
						options: sf.options,
					}))}
				/>
			)
		}
		return (
			<PillInput
				value={toStringArray(value)}
				onChange={(v) => onChange(v)}
				disabled={ro}
				separator={f.ui?.separator}
				placeholder={placeholder}
			/>
		)
	}

	// `enum` ───────────────────────────────────────────────────────────────────
	if (f.type === 'enum') {
		if (ro) {
			return (
				<input
					type="text"
					value={String(value ?? '')}
					disabled
					className="w-full px-3 py-2 bg-input border border-border rounded text-sm disabled:opacity-60"
				/>
			)
		}
		return (
			<EnumWidget
				field={f}
				value={String(value ?? '')}
				onChange={(v) => onChange(v)}
				placeholder={placeholder}
				onAddOption={onAddEnumOption}
			/>
		)
	}

	// `text` — localized branch first
	if (localized && locale) {
		return (
			<LocalizedTextField
				value={value}
				mode={locale.mode}
				activeLocale={locale.activeLocale}
				leftLocale={locale.leftLocale}
				rightLocale={locale.rightLocale}
				defaultLocale={locale.defaultLocale}
				onTranslate={onTranslate}
				translating={translating}
				onChange={(v) => onChange(v)}
				disabled={ro}
			/>
		)
	}

	// `text` — widget=textarea
	if (widget === 'textarea') {
		return (
			<textarea
				value={String(value ?? '')}
				onChange={(e) => onChange(e.target.value)}
				disabled={ro}
				rows={f.ui?.rows ?? 4}
				placeholder={placeholder}
				className="w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60 resize-y"
			/>
		)
	}

	// `text` — default single-line input
	return (
		<input
			type="text"
			value={String(value ?? '')}
			onChange={(e) => onChange(e.target.value)}
			disabled={ro}
			placeholder={placeholder}
			className={inputCls}
		/>
	)
}

/**
 * Enum dropdown widget. Renders the configured options and — when
 * `onAddOption` is supplied — adds a trailing "+ Add option…" row that mints
 * a new option inline. The caller is responsible for permission-gating
 * `onAddOption` (only users with schema-edit permission should see it).
 */
function EnumWidget({
	field,
	value,
	onChange,
	placeholder,
	onAddOption,
}: {
	field: CollectionField
	value: string
	onChange: (value: string) => void
	placeholder?: string
	onAddOption?: (newValue: string) => Promise<void> | void
}) {
	const { t } = useTranslation()
	const options = (field.options ?? []).map((o) => ({ value: o, label: o }))
	return (
		<Dropdown
			value={value}
			onChange={(v) => onChange(v)}
			options={options}
			placeholder={placeholder || t('editor.fieldRenderer.selectPlaceholder')}
			className="w-full"
			onAddOption={onAddOption}
			addOptionLabel={t('editor.fieldRenderer.addOption')}
		/>
	)
}
