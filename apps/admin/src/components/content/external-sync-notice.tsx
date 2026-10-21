import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useCollections } from '../../lib/collections'
import { useToast } from '../../lib/toast'
import type { ExternalSyncStatus } from '../../lib/use-external-sync-status'

export function ExternalSyncNotice({
	status,
	onReview,
	collectionId,
}: {
	status: ExternalSyncStatus | null
	onReview: () => void
	/** Needed to re-learn the fields when the source table's shape changed. */
	collectionId?: string
}) {
	const { t } = useTranslation()
	if (!status) return null
	const drift = status.schemaDrift ?? null
	if (!status.conflicts.length && !status.error && !drift) return null
	return (
		<div className="space-y-2">
			{drift && collectionId && <SchemaDriftNotice drift={drift} collectionId={collectionId} />}
			{(Boolean(status.conflicts.length) || status.error) && (
				<div
					role="status"
					className="flex flex-wrap items-center gap-3 px-4 py-3 bg-surface-alt border border-border rounded-lg text-sm"
				>
					<div className="flex-1">
						{Boolean(status.conflicts.length) && (
							<p className="font-medium">
								{t('collections.list.autoSync.conflicts', { count: status.conflicts.length })}
							</p>
						)}
						<p className="text-text-secondary">
							{t(
								status.error
									? 'collections.list.autoSync.retry'
									: 'collections.list.autoSync.message',
							)}
						</p>
					</div>
					{Boolean(status.conflicts.length) && (
						<button
							type="button"
							onClick={onReview}
							className="px-3 py-2 bg-btn-secondary rounded-md hover:bg-btn-secondary-hover"
						>
							{t('collections.list.autoSync.review')}
						</button>
					)}
				</div>
			)}
		</div>
	)
}

/**
 * "Source schema changed": the table gained, lost or retyped columns since the
 * collection learned it. Nothing in the editor changes until an admin reviews
 * it; updating re-learns the fields and keeps every label, widget and required
 * tick the schema editor set.
 */
function SchemaDriftNotice({
	drift,
	collectionId,
}: {
	drift: NonNullable<ExternalSyncStatus['schemaDrift']>
	collectionId: string
}) {
	const { t } = useTranslation()
	const { currentProject } = useAuth()
	const { refreshCollections } = useCollections()
	const toast = useToast()
	const [updating, setUpdating] = useState(false)
	const [done, setDone] = useState<string | null>(null)
	const canReview = currentProject?.role === 'owner' || currentProject?.role === 'admin'
	if (done === drift.hash) return null

	const names = (list: string[]) => list.slice(0, 4).join(', ') + (list.length > 4 ? '…' : '')
	const parts = [
		drift.added.length > 0 &&
			t('collections.list.schemaDrift.added', {
				count: drift.added.length,
				names: names(drift.added),
			}),
		drift.removed.length > 0 &&
			t('collections.list.schemaDrift.removed', {
				count: drift.removed.length,
				names: names(drift.removed),
			}),
		drift.changed.length > 0 &&
			t('collections.list.schemaDrift.changed', {
				count: drift.changed.length,
				names: names(drift.changed),
			}),
	].filter(Boolean)

	const update = async () => {
		setUpdating(true)
		try {
			const result = await api.post<{ unpreserved: Array<{ field: string }> }>(
				`/api/v1/collections/${collectionId}/rescan`,
				{},
			)
			await refreshCollections()
			setDone(drift.hash)
			toast(
				result.unpreserved.length > 0
					? t('collections.list.schemaDrift.updatedWithLosses', {
							names: result.unpreserved.map((change) => change.field).join(', '),
						})
					: t('collections.list.schemaDrift.updated'),
				'success',
			)
		} catch (err) {
			toast(
				err instanceof Error ? err.message : t('collections.list.schemaDrift.updateFailed'),
				'error',
			)
		} finally {
			setUpdating(false)
		}
	}

	return (
		<div
			role="status"
			className="flex flex-wrap items-center gap-3 px-4 py-3 bg-surface-alt border border-border rounded-lg text-sm"
		>
			<div className="flex-1 min-w-0">
				<p className="font-medium">{t('collections.list.schemaDrift.title')}</p>
				<p className="text-text-secondary">{parts.join(' · ')}</p>
				{!canReview && (
					<p className="text-text-muted text-xs mt-0.5">
						{t('collections.list.schemaDrift.askAdmin')}
					</p>
				)}
			</div>
			{canReview && (
				<button
					type="button"
					onClick={update}
					disabled={updating}
					className="px-3 py-2 bg-btn-secondary rounded-md hover:bg-btn-secondary-hover disabled:opacity-50"
				>
					{updating
						? t('collections.list.schemaDrift.updating')
						: t('collections.list.schemaDrift.review')}
				</button>
			)}
		</div>
	)
}
