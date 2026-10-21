/**
 * Shared plumbing for the shape-preset controls.
 *
 * A preset names roles (`url`, `alt`, `amount`…); a document names keys (`src`,
 * `altText`, `price`…). Every control reads and writes through the role → key
 * map, so it edits the document in its own vocabulary, and every control keeps
 * the keys the preset does not list: they stay in the value and show read-only
 * under "Other keys" instead of disappearing.
 */

import { type CollectionField, type FieldPreset, resolvePresetKeys } from '@innolope/config'
import { useTranslation } from 'react-i18next'

export type PresetValue = Record<string, unknown>

export function isPlainObject(value: unknown): value is PresetValue {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Role → key for this value: the field's recorded mapping first, then whatever
 * alias the value actually uses, then the role's preferred key.
 */
export function roleKeys(
	preset: FieldPreset,
	field: Pick<CollectionField, 'ui'>,
	value: unknown,
): Record<string, string> {
	const configured = field.ui?.presetKeys ?? {}
	const resolved = isPlainObject(value) ? (resolvePresetKeys(preset, value) ?? {}) : {}
	const keys: Record<string, string> = {}
	for (const role of preset.roles) {
		const present = isPlainObject(value) ? role.aliases.find((alias) => alias in value) : undefined
		keys[role.role] = configured[role.role] ?? resolved[role.role] ?? present ?? role.aliases[0]
	}
	return keys
}

/** Set one role's value, removing the key when it is cleared. */
export function setRole(
	value: unknown,
	keys: Record<string, string>,
	role: string,
	next: unknown,
): PresetValue {
	const out: PresetValue = isPlainObject(value) ? { ...value } : {}
	if (next === undefined || next === '' || next === null) delete out[keys[role]]
	else out[keys[role]] = next
	return out
}

/** Keys of the value no role maps to. */
export function otherKeys(value: unknown, keys: Record<string, string>): string[] {
	if (!isPlainObject(value)) return []
	const mapped = new Set(Object.values(keys))
	return Object.keys(value).filter((key) => !mapped.has(key))
}

export const presetInputCls =
	'w-full px-3 py-2 bg-input border border-border rounded text-sm focus:outline-none focus:border-border-strong disabled:opacity-60'

export const presetSmallInputCls =
	'w-full px-2 py-1.5 bg-input border border-border rounded text-xs focus:outline-none focus:border-border-strong disabled:opacity-60'

/** The unlisted keys of a value, read-only, so nothing is lost from view. */
export function OtherKeys({ value, keys }: { value: unknown; keys: Record<string, string> }) {
	const { t } = useTranslation()
	const extra = otherKeys(value, keys)
	if (extra.length === 0 || !isPlainObject(value)) return null
	return (
		<details className="text-xs">
			<summary className="cursor-pointer text-text-muted hover:text-text-secondary">
				{t('editor.subformField.otherKeys', { count: extra.length })}
			</summary>
			<pre className="mt-1 max-h-48 overflow-auto rounded bg-input p-2 font-mono text-[11px] text-text-secondary">
				{JSON.stringify(Object.fromEntries(extra.map((key) => [key, value[key]])), null, 2)}
			</pre>
		</details>
	)
}

/** A small labelled slot inside a composite control. */
export function Slot({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children.
		<label className="block min-w-0">
			<span className="mb-0.5 block text-[10px] text-text-muted">{label}</span>
			{children}
		</label>
	)
}
