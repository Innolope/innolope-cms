import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CollectionWithCount } from '../../lib/collections'
import { humanizeKey } from '../../lib/field-summary'
import { comparisonRows, comparisonText } from '../../lib/sync-comparison'
import type { SyncConflict } from './sync-conflicts-dialog'

function Context({ text }: { text: string }) {
	const { t } = useTranslation()
	const [expanded, setExpanded] = useState(false)
	if (text.length < 200) return <span>{text}</span>
	return (
		<span>
			{expanded ? (
				text
			) : (
				<>
					{text.slice(0, 60)}
					<span className="text-text-muted"> … </span>
					{text.slice(-60)}
				</>
			)}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="block my-1 text-xs underline text-text-secondary"
			>
				{t(
					expanded
						? 'collections.list.syncDialog.hideContext'
						: 'collections.list.syncDialog.showContext',
					{ count: text.length },
				)}
			</button>
		</span>
	)
}

function ValueDifference({
	local,
	external,
	side,
}: {
	local: unknown
	external: unknown
	side: 'local' | 'external'
}) {
	const { t } = useTranslation()
	const display = (value: unknown): string =>
		value === undefined
			? t('collections.list.syncDialog.missing')
			: value === null
				? t('collections.list.syncDialog.nullValue')
				: value === ''
					? t('collections.list.syncDialog.emptyText')
					: typeof value === 'string'
						? value
						: JSON.stringify(value, null, 2)
	const localText = display(local)
	const externalText = display(external)
	const kind = (value: unknown) =>
		value === undefined
			? 'missing'
			: value === null
				? 'null'
				: value === ''
					? 'empty'
					: Array.isArray(value)
						? 'array'
						: typeof value
	const typeChanged = kind(local) !== kind(external)
	const ownValue = side === 'local' ? localText : externalText
	const difference = useMemo(
		() => comparisonText(localText, externalText),
		[localText, externalText],
	)
	return (
		<div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
			{typeChanged && (
				<p className="mb-1 text-xs font-medium">
					{t(`collections.list.syncDialog.valueTypes.${kind(side === 'local' ? local : external)}`)}
				</p>
			)}
			{typeChanged ? (
				side === 'local' ? (
					<del className="bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100">
						{ownValue}
					</del>
				) : (
					<mark className="bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-100">
						{ownValue}
					</mark>
				)
			) : (
				difference.parts.map((part, index) => {
					if ((side === 'local' && part.added) || (side === 'external' && part.removed)) return null
					// Index describes ordered diff segments, never reorderable data.
					const key = `${index}:${part.added}:${part.removed}`
					if (part.removed)
						return (
							<del
								key={key}
								className="bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100 decoration-red-500"
							>
								{part.value}
							</del>
						)
					if (part.added)
						return (
							<mark
								key={key}
								className="bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-100"
							>
								{part.value}
							</mark>
						)
					return <Context key={key} text={part.value} />
				})
			)}
			{difference.grouped && (
				<p className="mt-2 text-xs text-text-secondary">
					{t('collections.list.syncDialog.grouped')}
				</p>
			)}
		</div>
	)
}

export function SyncConflictComparison({
	item,
	collection,
}: {
	item: SyncConflict
	collection: CollectionWithCount
}) {
	const { t, i18n } = useTranslation()
	const [shown, setShown] = useState(40)
	const rows = useMemo(
		() => (item.local && item.external ? comparisonRows(item.local, item.external) : []),
		[item.local, item.external],
	)
	if (!item.local || !item.external) return null
	if (rows.length === 0)
		return (
			<p className="mt-3 text-sm text-text-secondary">
				{t('collections.list.syncDialog.noDifferences')}
			</p>
		)
	const name = (path: string[]) => {
		const fields = path[0] === 'metadata' ? path.slice(1) : path
		const first = fields[0] ?? ''
		const field = collection.fields.find((candidate) => candidate.name === first)
		const label =
			first === 'markdown'
				? t('collections.list.syncDialog.areas.content')
				: field?.label || humanizeKey(first)
		const languages = new Intl.DisplayNames([i18n.language || 'en'], { type: 'language' })
		const rest = fields
			.slice(1)
			.map((part) =>
				/^\d+$/.test(part)
					? String(Number(part) + 1)
					: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(part)
						? languages.of(part) || part
						: humanizeKey(part),
			)
		return (
			<>
				<span>{label}</span>
				{rest.length > 0 && (
					<span className="text-text-secondary font-normal"> · {rest.join(' · ')}</span>
				)}
			</>
		)
	}
	return (
		<div className="mt-4 space-y-4">
			<p className="text-xs text-text-secondary">{t('collections.list.syncDialog.legend')}</p>
			{rows.slice(0, shown).map((row) => (
				<section
					key={JSON.stringify(row.path)}
					className="rounded border border-border overflow-hidden"
				>
					<h4 className="px-3 py-2 bg-surface-alt text-sm font-medium">{name(row.path)}</h4>
					<div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border">
						{(['local', 'external'] as const).map((side) => (
							<div key={side} className="p-3 min-w-0">
								<p className="sm:hidden mb-2 text-xs font-medium text-text-secondary">
									{t(`collections.list.syncDialog.${side}`)}
								</p>
								<ValueDifference local={row.local} external={row.external} side={side} />
							</div>
						))}
					</div>
				</section>
			))}
			{rows.length > shown && (
				<button type="button" className="text-sm underline" onClick={() => setShown(shown + 40)}>
					{t('collections.list.syncDialog.moreFields', { shown, total: rows.length })}
				</button>
			)}
		</div>
	)
}
