/**
 * A collection-table cell for a schema field, rendered by the field's shape.
 *
 * Complex fields used to be unreadable in the table (`[object]`, or
 * `[object Object],[object Object]` for a list of links). The same presets that
 * drive the editor drive the cell: an image is a thumbnail, a link its text,
 * money a formatted amount, a list a count with its first item on hover.
 */

import { type CollectionField, getPreset } from '@innolope/config'
import type { ReactNode } from 'react'
import { summarizeValue } from '../../lib/field-summary'
import { isPlainObject, roleKeys } from '../editor/presets/preset-utils'
import { ImageThumb } from '../media/image-thumb'

const muted = <span className="text-text-muted">—</span>

function formatMoney(amount: unknown, currency: unknown, locale?: string): string | null {
	const value = typeof amount === 'number' ? amount : Number(amount)
	if (!Number.isFinite(value)) return null
	if (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)) {
		try {
			return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
		} catch {
			// An unknown code: fall through to the plain number.
		}
	}
	return `${value}${typeof currency === 'string' ? ` ${currency}` : ''}`
}

function formatDate(value: unknown, locale?: string): string | null {
	if (!value) return null
	const date = new Date(value as string)
	return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale)
}

/**
 * The preset-aware rendering of a cell, or null to let the caller fall back to
 * its generic rendering.
 */
export function renderPresetCell(
	field: CollectionField,
	value: unknown,
	opts: { locale?: string } = {},
): ReactNode | null {
	if (value === null || value === undefined || value === '') return muted
	const preset = getPreset(field.ui?.preset)

	if (Array.isArray(value)) {
		if (value.length === 0) return muted
		if (!value.some(isPlainObject)) return null
		// A list of records: how many, and the first one on hover.
		const first = summarizeValue(value[0], {
			locale: opts.locale,
			summaryKey: field.ui?.summaryKey,
		})
		return (
			<span
				className="inline-flex items-center gap-1.5 text-xs text-text-secondary"
				title={first ?? undefined}
			>
				<span className="rounded-full bg-surface-alt px-1.5 py-0.5 font-mono text-[10px]">
					{value.length}
				</span>
				{first && <span className="max-w-[12rem] truncate">{first}</span>}
			</span>
		)
	}

	if (!preset) {
		if (!isPlainObject(value)) return null
		const summary = summarizeValue(value, { locale: opts.locale })
		return summary ? <span className="text-text-secondary">{summary}</span> : null
	}

	const keys = roleKeys(preset, field, value)
	const obj = isPlainObject(value) ? value : {}
	switch (preset.id) {
		case 'image': {
			const url = typeof value === 'string' ? value : obj[keys.url]
			return typeof url === 'string' && url ? (
				<ImageThumb url={url} className="h-8 w-8 rounded border border-border object-cover" />
			) : (
				muted
			)
		}
		case 'link': {
			const label = obj[keys.label] ?? obj[keys.url]
			return (
				<span className="text-text-secondary" title={String(obj[keys.url] ?? '')}>
					{String(label ?? '')}
				</span>
			)
		}
		case 'money': {
			const text = formatMoney(obj[keys.amount], obj[keys.currency], opts.locale)
			return text ? <span className="text-text-secondary tabular-nums">{text}</span> : muted
		}
		case 'geo-point': {
			const geojson = obj.type === 'Point' && Array.isArray(obj.coordinates)
			const lat = geojson ? (obj.coordinates as unknown[])[1] : obj[keys.lat]
			const lng = geojson ? (obj.coordinates as unknown[])[0] : obj[keys.lng]
			return (
				<span className="font-mono text-xs text-text-secondary">
					{String(lat)}, {String(lng)}
				</span>
			)
		}
		case 'date-range': {
			const start = formatDate(obj[keys.start], opts.locale)
			const end = formatDate(obj[keys.end], opts.locale)
			return (
				<span className="text-text-secondary">
					{start ?? '…'} – {end ?? '…'}
				</span>
			)
		}
		case 'address': {
			const parts = [obj[keys.city], obj[keys.country]].filter(
				(part) => typeof part === 'string' && part,
			)
			return parts.length ? <span className="text-text-secondary">{parts.join(', ')}</span> : muted
		}
		case 'seo': {
			const title = obj[keys.title]
			return typeof title === 'string' && title ? (
				<span className="text-text-secondary">{title}</span>
			) : (
				muted
			)
		}
		default:
			return null
	}
}
