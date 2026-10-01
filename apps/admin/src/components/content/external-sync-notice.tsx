import { useTranslation } from 'react-i18next'
import type { ExternalSyncStatus } from '../../lib/use-external-sync-status'

export function ExternalSyncNotice({
	status,
	onReview,
}: {
	status: ExternalSyncStatus | null
	onReview: () => void
}) {
	const { t } = useTranslation()
	if (!status?.conflicts.length && !status?.error) return null
	return (
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
						status.error ? 'collections.list.autoSync.retry' : 'collections.list.autoSync.message',
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
	)
}
