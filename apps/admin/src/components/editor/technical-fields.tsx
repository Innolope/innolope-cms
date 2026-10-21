/**
 * The "Technical fields" section at the bottom of the record form.
 *
 * Version counters, the source's own copies of the lifecycle columns, and values
 * the CMS cannot model (mixed types, unknown structure — `ui.opaque`) are not
 * something an editor should be typing into, and showing them inline as JSON
 * is what made imported records look broken. They collapse here, read-only, so
 * nothing is hidden and nothing is in the way. Admins can still change one by
 * editing it as JSON; that is the only way an opaque value is ever written.
 */

import type { CollectionField } from '@innolope/config'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SYSTEM_COLUMN_TWINS } from '../../lib/system-fields'
import { JsonField } from './json-field'

interface TechnicalFieldsProps {
	fields: CollectionField[]
	values: Record<string, unknown>
	labelFor: (field: CollectionField) => string
	/** Admins may edit a field as JSON; everyone else sees it read-only. */
	canEditJson: boolean
	disabled?: boolean
	onChange: (name: string, value: unknown) => void
}

function preview(value: unknown): { text: string; block: boolean } {
	if (value === null || value === undefined || value === '') return { text: '', block: false }
	if (typeof value === 'object') {
		try {
			return { text: JSON.stringify(value, null, 2), block: true }
		} catch {
			return { text: String(value), block: false }
		}
	}
	return { text: String(value), block: false }
}

export function TechnicalFields({
	fields,
	values,
	labelFor,
	canEditJson,
	disabled,
	onChange,
}: TechnicalFieldsProps) {
	const { t } = useTranslation()
	const [open, setOpen] = useState(false)
	const [editing, setEditing] = useState<Set<string>>(() => new Set())
	if (fields.length === 0) return null

	const toggleEditing = (name: string) =>
		setEditing((prev) => {
			const next = new Set(prev)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})

	return (
		<div className="border-t border-border pt-3">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text transition-colors w-full"
			>
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
					className={`transition-transform ${open ? 'rotate-90' : ''}`}
				>
					<polyline points="9 18 15 12 9 6" />
				</svg>
				{t('editor.technicalFields.title', { count: fields.length })}
			</button>
			{open && (
				<div className="mt-2 space-y-3">
					<p className="text-[11px] text-text-muted">{t('editor.technicalFields.hint')}</p>
					{fields.map((field) => {
						const value = values[field.name]
						// The lifecycle twins have their own controls; never a second editor.
						const editable = canEditJson && !disabled && !SYSTEM_COLUMN_TWINS.has(field.name)
						const isEditing = editable && editing.has(field.name)
						const { text, block } = preview(value)
						return (
							<div key={field.name} className="space-y-1">
								<div className="flex items-baseline justify-between gap-2">
									<span className="text-xs text-text-secondary" title={field.name}>
										{labelFor(field)}
									</span>
									{editable && (
										<button
											type="button"
											onClick={() => toggleEditing(field.name)}
											className="text-[10px] text-text-muted hover:text-text"
										>
											{isEditing
												? t('editor.technicalFields.doneEditing')
												: t('editor.technicalFields.editAsJson')}
										</button>
									)}
								</div>
								{field.ui?.opaque && (
									<span className="block text-[10px] text-text-muted">
										{t('editor.technicalFields.opaque')}
									</span>
								)}
								{isEditing ? (
									<JsonField
										value={value}
										onChange={(next) => onChange(field.name, next)}
										compact
									/>
								) : block ? (
									<pre className="max-h-48 overflow-auto rounded bg-input px-2 py-1.5 font-mono text-[11px] text-text-secondary">
										{text}
									</pre>
								) : (
									<p className="break-all font-mono text-xs text-text-secondary">
										{text || t('editor.technicalFields.empty')}
									</p>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}
