import type { CollectionField } from '@innolope/config'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { Dropdown } from '../dropdown'

/** Server ceiling for one action — mirrors BULK_ACTION_MAX in the API. */
const BULK_ACTION_MAX = 500

export type BulkAction =
	| 'publish'
	| 'unpublish'
	| 'archive'
	| 'submit-for-review'
	| 'delete'
	| 'set-field'

interface ItemResult {
	id: string
	ok: boolean
	error?: string
	warning?: string
}

interface BulkResponse {
	action: BulkAction
	requested: number
	succeeded: number
	failed: number
	results: ItemResult[]
}

interface BulkActionsBarProps {
	/** Ids ticked on the current page. */
	selectedIds: string[]
	/** Total records matching the active filter, across all pages. */
	total: number
	/** True once the user escalated to "everything matching the filter". */
	allMatching: boolean
	onSelectAllMatching: () => void
	onClear: () => void
	/** Active list filter, sent instead of ids when `allMatching` is set. */
	filter: Record<string, string>
	fields: CollectionField[]
	/** Review workflows are licensed; the button is absent without the entitlement. */
	showSubmitForReview: boolean
	/** Re-fetch the list after anything changes. */
	onDone: () => void
}

/**
 * The action bar that replaces the list header while rows are selected.
 *
 * Two selection modes reach the API differently: ticked rows send their ids,
 * while "all N matching" sends the filter itself and lets the server resolve it,
 * so the action covers records the user never paged to. That second mode is why
 * delete asks the user to type the record count — an off-by-one in a filter is
 * invisible, and there is no undo.
 */
export function BulkActionsBar({
	selectedIds,
	total,
	allMatching,
	onSelectAllMatching,
	onClear,
	filter,
	fields,
	showSubmitForReview,
	onDone,
}: BulkActionsBarProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const confirm = useConfirm()
	const [busy, setBusy] = useState(false)
	const [fieldEditorOpen, setFieldEditorOpen] = useState(false)

	const count = allMatching ? total : selectedIds.length
	const overLimit = count > BULK_ACTION_MAX

	const run = async (action: BulkAction, extra?: Record<string, unknown>) => {
		setBusy(true)
		try {
			const res = await api.post<BulkResponse>('/api/v1/content/bulk-action', {
				action,
				...(allMatching ? { filter } : { ids: selectedIds }),
				...extra,
			})
			reportOutcome(res)
			onClear()
			onDone()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('collections.bulk.failed'), 'error')
		} finally {
			setBusy(false)
		}
	}

	/**
	 * Per-row results collapse into one message. Warnings are surfaced separately
	 * from failures: a warned row DID change, it just left something behind (an
	 * orphaned external document), and treating that as a failure would send the
	 * user hunting for a record that is already gone.
	 */
	const reportOutcome = (res: BulkResponse) => {
		const warnings = res.results.filter((r) => r.ok && r.warning)
		if (res.failed === 0) {
			toast(t('collections.bulk.done', { count: res.succeeded }), 'success')
		} else {
			const firstError = res.results.find((r) => !r.ok)?.error
			toast(
				t('collections.bulk.partial', {
					succeeded: res.succeeded,
					failed: res.failed,
					reason: firstError ?? '',
				}),
				'error',
			)
		}
		for (const w of warnings.slice(0, 3)) toast(w.warning as string, 'error')
	}

	const confirmDelete = async () => {
		const ok = await confirm({
			title: t('collections.bulk.deleteTitle', { count }),
			message: t('collections.bulk.deleteMessage', { count }),
			confirmLabel: t('collections.bulk.deleteConfirm'),
			danger: true,
			// Typing the count is only demanded for the mode that can reach records
			// the user never saw; ticked rows are already an explicit, visible choice.
			...(allMatching && { requireText: String(count) }),
		})
		if (ok) await run('delete')
	}

	const actionButton = (action: BulkAction, label: string, onClick?: () => void) => (
		<button
			key={action}
			type="button"
			disabled={busy || overLimit}
			onClick={onClick ?? (() => run(action))}
			className="px-3 py-1.5 rounded text-sm bg-btn-secondary text-text-secondary hover:bg-btn-secondary-hover transition-colors disabled:opacity-40"
		>
			{label}
		</button>
	)

	return (
		<>
			<div className="flex flex-wrap items-center gap-2 px-4 py-3 mb-3 rounded-lg border border-border bg-surface-alt">
				<span className="text-sm text-text font-medium">
					{t('collections.bulk.selected', { count })}
				</span>

				{/* Escalation to the whole filtered set — only offered when the page is
				    fully ticked and there is more beyond it. */}
				{!allMatching && selectedIds.length > 0 && total > selectedIds.length && (
					<button
						type="button"
						onClick={onSelectAllMatching}
						className="text-sm text-accent underline underline-offset-2 hover:opacity-80"
					>
						{t('collections.bulk.selectAllMatching', { count: total })}
					</button>
				)}

				<button
					type="button"
					onClick={onClear}
					className="text-sm text-text-muted underline underline-offset-2 hover:text-text"
				>
					{t('collections.bulk.clear')}
				</button>

				<div className="flex-1" />

				{overLimit ? (
					<span className="text-sm text-danger">
						{t('collections.bulk.overLimit', { count, max: BULK_ACTION_MAX })}
					</span>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						{actionButton('publish', t('collections.bulk.publish'))}
						{actionButton('unpublish', t('collections.bulk.unpublish'))}
						{actionButton('archive', t('collections.bulk.archive'))}
						{showSubmitForReview &&
							actionButton('submit-for-review', t('collections.bulk.submitForReview'))}
						{actionButton('set-field', t('collections.bulk.setField'), () =>
							setFieldEditorOpen(true),
						)}
						<button
							type="button"
							disabled={busy}
							onClick={confirmDelete}
							className="px-3 py-1.5 rounded text-sm bg-danger text-white hover:opacity-90 transition-opacity disabled:opacity-40"
						>
							{t('collections.bulk.delete')}
						</button>
					</div>
				)}
			</div>

			{fieldEditorOpen && (
				<SetFieldDialog
					fields={fields}
					count={count}
					onCancel={() => setFieldEditorOpen(false)}
					onApply={async (field, value) => {
						setFieldEditorOpen(false)
						await run('set-field', { field, value })
					}}
				/>
			)}
		</>
	)
}

/** Field types whose value can be expressed in one small input. */
const SETTABLE_TYPES = new Set(['text', 'number', 'boolean', 'enum', 'date'])

/**
 * Pick one schema field and a value to apply to every selected record.
 *
 * Deliberately limited to scalar types — a relation or an array needs the record
 * editor's own widgets, and half-supporting them here would be worse than
 * sending the user to the record.
 */
function SetFieldDialog({
	fields,
	count,
	onCancel,
	onApply,
}: {
	fields: CollectionField[]
	count: number
	onCancel: () => void
	onApply: (field: string, value: unknown) => void
}) {
	const { t } = useTranslation()
	const settable = fields.filter(
		(f) => SETTABLE_TYPES.has(f.type) && !f.ui?.readOnly && !f.ui?.hidden,
	)
	const [fieldName, setFieldName] = useState(settable[0]?.name ?? '')
	const [raw, setRaw] = useState('')
	const field = settable.find((f) => f.name === fieldName)

	const coerced = (): unknown => {
		if (!field) return raw
		if (field.type === 'number') return raw === '' ? null : Number(raw)
		if (field.type === 'boolean') return raw === 'true'
		return raw
	}

	const valid = field && (field.type === 'boolean' || raw !== '')

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<button
				type="button"
				aria-label={t('common.closeDialog')}
				className="absolute inset-0 -z-10 cursor-default"
				onClick={onCancel}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t('collections.bulk.setFieldTitle')}
				className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg p-8"
			>
				<h3 className="text-lg font-semibold text-text mb-2">
					{t('collections.bulk.setFieldTitle')}
				</h3>
				<p className="text-sm text-text-secondary mb-6">
					{t('collections.bulk.setFieldMessage', { count })}
				</p>

				{settable.length === 0 ? (
					<p className="text-sm text-text-secondary mb-6">
						{t('collections.bulk.setFieldNoFields')}
					</p>
				) : (
					<div className="space-y-4 mb-8">
						<Dropdown
							value={fieldName}
							onChange={(v) => {
								setFieldName(v)
								setRaw('')
							}}
							options={settable.map((f) => ({ value: f.name, label: f.label || f.name }))}
						/>

						{field?.type === 'boolean' ? (
							<Dropdown
								value={raw || 'false'}
								onChange={setRaw}
								options={[
									{ value: 'true', label: t('editor.fieldRenderer.yes') },
									{ value: 'false', label: t('editor.fieldRenderer.no') },
								]}
							/>
						) : field?.type === 'enum' && field.options?.length ? (
							<Dropdown
								value={raw}
								onChange={setRaw}
								options={field.options.map((o) => ({ value: o, label: o }))}
							/>
						) : (
							<input
								type={
									field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'
								}
								value={raw}
								onChange={(e) => setRaw(e.target.value)}
								placeholder={t('collections.bulk.setFieldValuePlaceholder')}
								className="w-full px-3 py-2.5 bg-input border border-border-strong rounded text-sm text-text focus:outline-none focus:border-border-strong"
							/>
						)}
					</div>
				)}

				<div className="flex gap-3 justify-end">
					<button
						type="button"
						onClick={onCancel}
						className="px-5 py-2.5 bg-btn-secondary text-text-secondary rounded-lg text-sm hover:bg-btn-secondary-hover transition-colors"
					>
						{t('common.cancel')}
					</button>
					<button
						type="button"
						disabled={!valid}
						onClick={() => field && onApply(field.name, coerced())}
						className="px-5 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors disabled:opacity-40"
					>
						{t('collections.bulk.setFieldApply')}
					</button>
				</div>
			</div>
		</div>
	)
}
