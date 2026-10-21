/**
 * Composite controls for shape presets: an image looks like an image, money is
 * one input with a currency, a date range is two pickers that check each other.
 * The editor never sees `{ amount, currency }` as two unrelated inputs.
 *
 * `PresetField` dispatches on `ui.preset`; `presetHandles` says whether a field
 * gets a preset control at all, so the field renderer can fall back to the
 * generic widgets for anything else.
 */

import { type CollectionField, type FieldPreset, getPreset } from '@innolope/config'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { summarizeValue } from '../../../lib/field-summary'
import { toNumberValue } from '../../../lib/number-value'
import { Dropdown } from '../../dropdown'
import { ImageThumb } from '../../media/image-thumb'
import { ImagePickerModal } from '../image-picker-modal'
import { PillInput } from '../pill-input'
import {
	isPlainObject,
	OtherKeys,
	presetInputCls,
	presetSmallInputCls,
	roleKeys,
	Slot,
	setRole,
} from './preset-utils'

interface PresetFieldProps {
	field: CollectionField
	value: unknown
	onChange: (value: unknown) => void
	disabled?: boolean
	locale?: string
}

/** Presets that render rows of their object (`[{ platform, url }]`). */
const ROW_PRESETS = new Set(['link', 'social-link'])

/** Whether this field renders through a preset control. */
export function presetHandles(field: CollectionField, value: unknown): boolean {
	const preset = getPreset(field.ui?.preset)
	if (!preset || preset.id === 'rich-text' || field.localized) return false
	if (field.type === 'text') return preset.id === 'image'
	if (field.type === 'array') return preset.id === 'key-value' || ROW_PRESETS.has(preset.id)
	if (field.type !== 'object') return false
	// A value that is plainly not this shape (an array, a string) is left to the
	// generic widgets rather than squeezed through the control.
	return value === undefined || value === null || isPlainObject(value)
}

export function PresetField(props: PresetFieldProps) {
	const preset = getPreset(props.field.ui?.preset)
	if (!preset) return null
	if (props.field.type === 'array') {
		return preset.id === 'key-value' ? (
			<KeyValueControl {...props} preset={preset} />
		) : (
			<PresetRows {...props} preset={preset} />
		)
	}
	switch (preset.id) {
		case 'image':
			return <ImageControl {...props} preset={preset} />
		case 'link':
			return <LinkControl {...props} preset={preset} />
		case 'social-link':
			return <SocialLinkControl {...props} preset={preset} />
		case 'seo':
			return <SeoControl {...props} preset={preset} />
		case 'money':
			return <MoneyControl {...props} preset={preset} />
		case 'geo-point':
			return <GeoPointControl {...props} preset={preset} />
		case 'address':
			return <AddressControl {...props} preset={preset} />
		case 'date-range':
			return <DateRangeControl {...props} preset={preset} />
		default:
			return null
	}
}

type ControlProps = PresetFieldProps & { preset: FieldPreset; compact?: boolean }

// ─── Image ───────────────────────────────────────────────────────────────────

function ImageControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const [picking, setPicking] = useState(false)
	// A text field holds the URL itself; an object holds it under its url key.
	const asText = field.type === 'text'
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const url = asText ? (typeof value === 'string' ? value : '') : String(obj[keys.url] ?? '')
	const setUrl = (next: string) => onChange(asText ? next : setRole(value, keys, 'url', next))
	const hasSize = !asText && (keys.width in obj || keys.height in obj)

	return (
		<div className="space-y-2">
			<div className="flex gap-3">
				<div className="h-20 w-20 shrink-0 overflow-hidden rounded border border-border bg-surface-alt">
					{url ? (
						<ImageThumb url={url} className="h-full w-full object-cover" />
					) : (
						<div className="flex h-full w-full items-center justify-center text-[10px] text-text-muted">
							{t('editor.presets.image.none')}
						</div>
					)}
				</div>
				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex gap-2">
						<input
							type="text"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							disabled={disabled}
							placeholder={t('editor.presets.image.url')}
							className={presetInputCls}
						/>
						{!disabled && (
							<button
								type="button"
								onClick={() => setPicking(true)}
								className="shrink-0 rounded bg-btn-secondary px-3 text-xs hover:bg-btn-secondary-hover"
							>
								{t('editor.presets.image.choose')}
							</button>
						)}
					</div>
					{!asText && (
						<input
							type="text"
							value={String(obj[keys.alt] ?? '')}
							onChange={(e) => onChange(setRole(value, keys, 'alt', e.target.value))}
							disabled={disabled}
							placeholder={t('editor.presets.image.alt')}
							className={presetInputCls}
						/>
					)}
				</div>
			</div>
			{hasSize && (
				<div className="grid grid-cols-2 gap-2">
					{(['width', 'height'] as const).map((role) => (
						<Slot key={role} label={t(`editor.presets.image.${role}`)}>
							<input
								type="number"
								value={String(obj[keys[role]] ?? '')}
								onChange={(e) =>
									onChange(
										setRole(value, keys, role, e.target.value ? Number(e.target.value) : undefined),
									)
								}
								disabled={disabled}
								className={presetSmallInputCls}
							/>
						</Slot>
					))}
				</div>
			)}
			{!asText && <OtherKeys value={value} keys={keys} />}
			{picking && (
				<ImagePickerModal
					onClose={() => setPicking(false)}
					onSelect={(image) => {
						setPicking(false)
						if (asText) {
							onChange(image.url)
							return
						}
						let next = setRole(value, keys, 'url', image.url)
						if (image.alt && !obj[keys.alt]) next = setRole(next, keys, 'alt', image.alt)
						onChange(next)
					}}
				/>
			)}
		</div>
	)
}

// ─── Link and social link ────────────────────────────────────────────────────

function LinkControl({ field, value, onChange, disabled, preset, compact }: ControlProps) {
	const { t } = useTranslation()
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const cls = compact ? presetSmallInputCls : presetInputCls
	return (
		<div className="space-y-1">
			<div className="grid grid-cols-[2fr_3fr] gap-2">
				<input
					type="text"
					value={String(obj[keys.label] ?? '')}
					onChange={(e) => onChange(setRole(value, keys, 'label', e.target.value))}
					disabled={disabled}
					placeholder={t('editor.presets.link.label')}
					className={cls}
				/>
				<input
					type="text"
					value={String(obj[keys.url] ?? '')}
					onChange={(e) => onChange(setRole(value, keys, 'url', e.target.value))}
					disabled={disabled}
					placeholder={t('editor.presets.link.url')}
					className={cls}
				/>
			</div>
			{!compact && <OtherKeys value={value} keys={keys} />}
		</div>
	)
}

const KNOWN_PLATFORMS = [
	'linkedin',
	'x',
	'twitter',
	'instagram',
	'facebook',
	'youtube',
	'tiktok',
	'github',
	'mastodon',
	'threads',
	'website',
]

function SocialLinkControl({ field, value, onChange, disabled, preset, compact }: ControlProps) {
	const { t } = useTranslation()
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const platform = String(obj[keys.platform] ?? '')
	const declared = field.ui?.subFields?.find((sf) => sf.name === keys.platform)?.options
	const options = [...new Set([...(declared ?? KNOWN_PLATFORMS), ...(platform ? [platform] : [])])]
	return (
		<div className="space-y-1">
			<div className="grid grid-cols-[minmax(7rem,1fr)_3fr] gap-2">
				<Dropdown
					value={platform}
					onChange={(next) => onChange(setRole(value, keys, 'platform', next))}
					options={options.map((option) => ({ value: option, label: option }))}
					placeholder={t('editor.presets.social.platform')}
					disabled={disabled}
					className="w-full"
				/>
				<input
					type="text"
					value={String(obj[keys.url] ?? '')}
					onChange={(e) => onChange(setRole(value, keys, 'url', e.target.value))}
					disabled={disabled}
					placeholder={t('editor.presets.link.url')}
					className={compact ? presetSmallInputCls : presetInputCls}
				/>
			</div>
			{!compact && <OtherKeys value={value} keys={keys} />}
		</div>
	)
}

/** Rows of a row preset: one compact control per element. */
function PresetRows({ field, value, onChange, disabled, preset, locale }: ControlProps) {
	const { t } = useTranslation()
	const rows = Array.isArray(value) ? value : []
	const Row = preset.id === 'social-link' ? SocialLinkControl : LinkControl
	const update = (index: number, next: unknown) =>
		onChange(rows.map((row, i) => (i === index ? next : row)))
	const move = (index: number, delta: -1 | 1) => {
		const target = index + delta
		if (target < 0 || target >= rows.length) return
		const next = [...rows]
		;[next[index], next[target]] = [next[target], next[index]]
		onChange(next)
	}
	return (
		<div className="space-y-1.5">
			{rows.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity of their own.
				<div key={index} className="flex items-start gap-1">
					<div className="min-w-0 flex-1" title={summarizeValue(row, { locale }) ?? undefined}>
						<Row
							field={field}
							value={row}
							onChange={(next) => update(index, next)}
							disabled={disabled}
							preset={preset}
							compact
						/>
					</div>
					{!disabled && (
						<div className="flex shrink-0 items-center pt-1.5">
							<button
								type="button"
								onClick={() => move(index, -1)}
								disabled={index === 0}
								className="px-1 text-xs text-text-muted hover:text-text disabled:opacity-30"
								aria-label={t('editor.objectArrayField.moveUp', { index: index + 1 })}
							>
								↑
							</button>
							<button
								type="button"
								onClick={() => move(index, 1)}
								disabled={index === rows.length - 1}
								className="px-1 text-xs text-text-muted hover:text-text disabled:opacity-30"
								aria-label={t('editor.objectArrayField.moveDown', { index: index + 1 })}
							>
								↓
							</button>
							<button
								type="button"
								onClick={() => onChange(rows.filter((_, i) => i !== index))}
								className="px-1 text-sm leading-none text-text-muted hover:text-danger"
								aria-label={t('editor.objectArrayField.removeRow', { index: index + 1 })}
							>
								&times;
							</button>
						</div>
					)}
				</div>
			))}
			{!disabled && (
				<button
					type="button"
					onClick={() => onChange([...rows, {}])}
					className="text-xs text-text-muted transition-colors hover:text-text-secondary"
				>
					{t('editor.objectArrayField.addRow')}
				</button>
			)}
		</div>
	)
}

// ─── SEO ─────────────────────────────────────────────────────────────────────

/** Lengths search engines show before truncating. */
const SEO_LIMITS = { title: 60, description: 160 }

function Counter({ length, max }: { length: number; max: number }) {
	return (
		<span className={`text-[10px] ${length > max ? 'text-danger' : 'text-text-muted'}`}>
			{length} / {max}
		</span>
	)
}

function SeoControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const [open, setOpen] = useState(false)
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const text = (role: string) => String(obj[keys[role]] ?? '')
	const keywords = obj[keys.keywords]
	const keywordList = Array.isArray(keywords)
		? keywords.map(String)
		: typeof keywords === 'string' && keywords
			? keywords.split(',').map((k) => k.trim())
			: []

	return (
		<div className="rounded border border-border bg-surface">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 px-3 py-2 text-left"
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
					className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
				>
					<polyline points="9 18 15 12 9 6" />
				</svg>
				<span className="min-w-0 flex-1 truncate text-sm">
					{text('title') || (
						<span className="italic text-text-muted">{t('editor.presets.seo.empty')}</span>
					)}
				</span>
			</button>
			{open && (
				<div className="space-y-3 border-t border-border p-3">
					<div>
						<div className="mb-0.5 flex items-baseline justify-between">
							<span className="text-[10px] text-text-muted">{t('editor.presets.seo.title')}</span>
							<Counter length={text('title').length} max={SEO_LIMITS.title} />
						</div>
						<input
							type="text"
							value={text('title')}
							onChange={(e) => onChange(setRole(value, keys, 'title', e.target.value))}
							disabled={disabled}
							className={presetInputCls}
						/>
					</div>
					<div>
						<div className="mb-0.5 flex items-baseline justify-between">
							<span className="text-[10px] text-text-muted">
								{t('editor.presets.seo.description')}
							</span>
							<Counter length={text('description').length} max={SEO_LIMITS.description} />
						</div>
						<textarea
							value={text('description')}
							onChange={(e) => onChange(setRole(value, keys, 'description', e.target.value))}
							disabled={disabled}
							rows={3}
							className={`${presetInputCls} resize-y`}
						/>
					</div>
					{(keys.keywords in obj || !disabled) && (
						<Slot label={t('editor.presets.seo.keywords')}>
							<PillInput
								value={keywordList}
								onChange={(next) =>
									onChange(
										setRole(
											value,
											keys,
											'keywords',
											// Keep a comma string a comma string.
											typeof keywords === 'string' ? next.join(', ') : next,
										),
									)
								}
								disabled={disabled}
								separator="both"
							/>
						</Slot>
					)}
					<Slot label={t('editor.presets.seo.ogImage')}>
						<input
							type="text"
							value={text('ogImage')}
							onChange={(e) => onChange(setRole(value, keys, 'ogImage', e.target.value))}
							disabled={disabled}
							placeholder="https://…"
							className={presetInputCls}
						/>
					</Slot>
					<Slot label={t('editor.presets.seo.canonical')}>
						<input
							type="text"
							value={text('canonical')}
							onChange={(e) => onChange(setRole(value, keys, 'canonical', e.target.value))}
							disabled={disabled}
							placeholder="https://…"
							className={presetInputCls}
						/>
					</Slot>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={obj[keys.noindex] === true}
							onChange={(e) =>
								onChange(setRole(value, keys, 'noindex', e.target.checked ? true : undefined))
							}
							disabled={disabled}
							className="rounded"
						/>
						<span className="text-text-secondary">{t('editor.presets.seo.noindex')}</span>
					</label>
					<OtherKeys value={value} keys={keys} />
				</div>
			)}
		</div>
	)
}

// ─── Money ───────────────────────────────────────────────────────────────────

const CURRENCIES = [
	'USD',
	'EUR',
	'GBP',
	'UAH',
	'PLN',
	'CHF',
	'JPY',
	'CAD',
	'AUD',
	'SEK',
	'NOK',
	'CZK',
]

function MoneyControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const currency = String(obj[keys.currency] ?? '')
	const options = [...new Set([...(currency ? [currency] : []), ...CURRENCIES])]
	return (
		<div className="space-y-1">
			<div className="flex">
				<input
					type="number"
					step="any"
					value={
						obj[keys.amount] === undefined || obj[keys.amount] === null
							? ''
							: String(obj[keys.amount])
					}
					onChange={(e) =>
						onChange(
							setRole(
								value,
								keys,
								'amount',
								e.target.value ? toNumberValue(e.target.value) : undefined,
							),
						)
					}
					disabled={disabled}
					placeholder={t('editor.presets.money.amount')}
					className={`${presetInputCls} rounded-r-none`}
				/>
				<Dropdown
					value={currency}
					onChange={(next) => onChange(setRole(value, keys, 'currency', next))}
					options={options.map((code) => ({ value: code, label: code }))}
					placeholder={t('editor.presets.money.currency')}
					disabled={disabled}
					className="w-28 shrink-0"
				/>
			</div>
			<OtherKeys value={value} keys={keys} />
		</div>
	)
}

// ─── Map point ───────────────────────────────────────────────────────────────

function GeoPointControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const obj = isPlainObject(value) ? value : {}
	// GeoJSON keeps [lng, lat] in `coordinates`; everything else uses two keys.
	const geojson = obj.type === 'Point' && Array.isArray(obj.coordinates)
	const keys = roleKeys(preset, field, value)
	const coordinates = geojson ? (obj.coordinates as unknown[]) : []
	const lat = geojson ? coordinates[1] : obj[keys.lat]
	const lng = geojson ? coordinates[0] : obj[keys.lng]
	const set = (role: 'lat' | 'lng', text: string) => {
		const next = text === '' ? undefined : Number(text)
		if (geojson) {
			const pair = [...coordinates]
			pair[role === 'lat' ? 1 : 0] = next ?? null
			onChange({ ...obj, coordinates: pair })
			return
		}
		onChange(setRole(value, keys, role, next))
	}
	const valid =
		typeof lat === 'number' &&
		typeof lng === 'number' &&
		Math.abs(lat) <= 90 &&
		Math.abs(lng) <= 180
	return (
		<div className="space-y-1">
			<div className="grid grid-cols-2 gap-2">
				<Slot label={t('editor.presets.geo.lat')}>
					<input
						type="number"
						step="any"
						min={-90}
						max={90}
						value={lat === undefined || lat === null ? '' : String(lat)}
						onChange={(e) => set('lat', e.target.value)}
						disabled={disabled}
						className={presetInputCls}
					/>
				</Slot>
				<Slot label={t('editor.presets.geo.lng')}>
					<input
						type="number"
						step="any"
						min={-180}
						max={180}
						value={lng === undefined || lng === null ? '' : String(lng)}
						onChange={(e) => set('lng', e.target.value)}
						disabled={disabled}
						className={presetInputCls}
					/>
				</Slot>
			</div>
			{valid && (
				<a
					href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`}
					target="_blank"
					rel="noreferrer noopener"
					className="text-xs text-text-muted underline hover:text-text"
				>
					{t('editor.presets.geo.viewMap')}
				</a>
			)}
			{!geojson && <OtherKeys value={value} keys={keys} />}
		</div>
	)
}

// ─── Address ─────────────────────────────────────────────────────────────────

function AddressControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const input = (role: string) => (
		<Slot label={t(`editor.presets.address.${role}`)}>
			<input
				type="text"
				value={String(obj[keys[role]] ?? '')}
				onChange={(e) => onChange(setRole(value, keys, role, e.target.value))}
				disabled={disabled}
				className={presetInputCls}
			/>
		</Slot>
	)
	return (
		<div className="space-y-2 rounded border border-border bg-surface p-3">
			{input('street')}
			{keys.line2 in obj && input('line2')}
			<div className="grid grid-cols-2 gap-2">
				{input('city')}
				{input('region')}
			</div>
			<div className="grid grid-cols-2 gap-2">
				{input('postalCode')}
				{input('country')}
			</div>
			<OtherKeys value={value} keys={keys} />
		</div>
	)
}

// ─── Date range ──────────────────────────────────────────────────────────────

/** `yyyy-mm-dd` for a date input, from an ISO string, a date-only string or a Date. */
function toDateInput(value: unknown): string {
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
	if (!value) return ''
	const date = new Date(value as string)
	return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function DateRangeControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	const start = toDateInput(obj[keys.start])
	const end = toDateInput(obj[keys.end])
	// Write back in the shape the document already uses: date-only stays date-only.
	const dateOnly = [obj[keys.start], obj[keys.end]].some(
		(v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
	)
	const set = (role: 'start' | 'end', text: string) =>
		onChange(
			setRole(
				value,
				keys,
				role,
				text ? (dateOnly ? text : new Date(`${text}T00:00:00.000Z`).toISOString()) : undefined,
			),
		)
	const invalid = Boolean(start && end && end < start)
	return (
		<div className="space-y-1">
			<div className="grid grid-cols-2 gap-2">
				<Slot label={t('editor.presets.dateRange.start')}>
					<input
						type="date"
						value={start}
						onChange={(e) => set('start', e.target.value)}
						disabled={disabled}
						className={presetInputCls}
					/>
				</Slot>
				<Slot label={t('editor.presets.dateRange.end')}>
					<input
						type="date"
						value={end}
						min={start || undefined}
						onChange={(e) => set('end', e.target.value)}
						disabled={disabled}
						className={presetInputCls}
					/>
				</Slot>
			</div>
			{invalid && (
				<p className="text-xs text-danger" role="alert">
					{t('editor.presets.dateRange.invalid')}
				</p>
			)}
			<OtherKeys value={value} keys={keys} />
		</div>
	)
}

// ─── Key-value table ─────────────────────────────────────────────────────────

function KeyValueControl({ field, value, onChange, disabled, preset }: ControlProps) {
	const { t } = useTranslation()
	const rows = (Array.isArray(value) ? value : []).filter(isPlainObject)
	const keys = roleKeys(preset, field, rows[0])
	const update = (index: number, role: 'key' | 'value', text: string) =>
		onChange(rows.map((row, i) => (i === index ? { ...row, [keys[role]]: text } : row)))
	return (
		<div className="space-y-1.5">
			{rows.length > 0 && (
				<div className="grid grid-cols-[2fr_3fr_auto] gap-2 text-[10px] text-text-muted">
					<span>{t('editor.presets.keyValue.key')}</span>
					<span>{t('editor.presets.keyValue.value')}</span>
					<span className="w-4" />
				</div>
			)}
			{rows.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable identity of their own.
				<div key={index} className="grid grid-cols-[2fr_3fr_auto] items-center gap-2">
					<input
						type="text"
						value={String(row[keys.key] ?? '')}
						onChange={(e) => update(index, 'key', e.target.value)}
						disabled={disabled}
						className={presetSmallInputCls}
					/>
					<input
						type="text"
						value={String(row[keys.value] ?? '')}
						onChange={(e) => update(index, 'value', e.target.value)}
						disabled={disabled}
						className={presetSmallInputCls}
					/>
					{disabled ? (
						<span className="w-4" />
					) : (
						<button
							type="button"
							onClick={() => onChange(rows.filter((_, i) => i !== index))}
							className="w-4 text-sm leading-none text-text-muted hover:text-danger"
							aria-label={t('editor.objectArrayField.removeRow', { index: index + 1 })}
						>
							&times;
						</button>
					)}
				</div>
			))}
			{!disabled && (
				<button
					type="button"
					onClick={() => onChange([...rows, { [keys.key]: '', [keys.value]: '' }])}
					className="text-xs text-text-muted transition-colors hover:text-text-secondary"
				>
					{t('editor.objectArrayField.addRow')}
				</button>
			)}
		</div>
	)
}
