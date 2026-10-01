import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CollectionWithCount } from '../../lib/collections'
import { resolveDisplayTitle } from '../../lib/display-title'

export interface SyncConflict {
	contentId: string
	externalId: string
	slug: string | null
	metadata: Record<string, unknown>
	token: string
	local?: { metadata: Record<string, unknown>; markdown: string; status: string }
	external?: { metadata: Record<string, unknown>; markdown: string; status: string }
	categories: Array<'content' | 'details' | 'status'>
}
export type SyncResolutions = Record<string, { token: string; choice: 'local' | 'external' }>

export function SyncConflictsDialog({
	conflicts,
	collection,
	defaultLocale,
	syncing,
	onCancel,
	onConfirm,
}: {
	conflicts: SyncConflict[]
	collection: CollectionWithCount
	defaultLocale: string
	syncing: boolean
	onCancel: () => void
	onConfirm: (resolutions: SyncResolutions) => void
}) {
	const { t } = useTranslation()
	const [choices, setChoices] = useState<SyncResolutions>({})
	const ready = conflicts.every((item) => choices[item.contentId]?.token === item.token)
	return (
		<div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-6">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="sync-conflicts-title"
				className="w-full max-w-2xl max-h-[82vh] bg-surface border border-border rounded-lg shadow-xl flex flex-col"
			>
				<div className="p-5 border-b border-border">
					<h3 id="sync-conflicts-title" className="text-lg font-semibold text-text">
						{t('collections.list.syncDialog.title')}
					</h3>
					<p className="mt-2 text-sm text-text-secondary">
						{t('collections.list.syncDialog.intro', { count: conflicts.length })}
					</p>
				</div>
				<div className="overflow-auto p-5 space-y-4">
					{conflicts.map((item) => (
						<fieldset
							key={item.contentId}
							disabled={syncing}
							className="border border-border rounded-lg p-4"
						>
							<legend className="px-1 text-sm font-medium text-text">
								{resolveDisplayTitle({ ...item, id: item.contentId }, collection, {
									defaultLocale,
								})}
							</legend>
							<p className="text-sm text-text-secondary mb-3">
								{t('collections.list.syncDialog.recordConflict', {
									areas: item.categories
										.map((area) => t(`collections.list.syncDialog.areas.${area}`))
										.join(', '),
								})}
							</p>
							<div className="grid sm:grid-cols-2 gap-2">
								{(['local', 'external'] as const).map((choice) => (
									<label
										key={choice}
										className="flex gap-2 items-center p-3 rounded border border-border text-sm cursor-pointer hover:bg-surface-alt"
									>
										<input
											type="radio"
											name={`sync-${item.contentId}`}
											value={choice}
											aria-label={t(`collections.list.syncDialog.${choice}`)}
											checked={
												choices[item.contentId]?.token === item.token &&
												choices[item.contentId]?.choice === choice
											}
											onChange={() =>
												setChoices((current) => ({
													...current,
													[item.contentId]: { token: item.token, choice },
												}))
											}
										/>
										<span className="min-w-0">
											<span className="block font-medium">
												{t(`collections.list.syncDialog.${choice}`)}
											</span>
											{item[choice] && (
												<span className="block mt-1 text-xs text-text-secondary break-words">
													{resolveDisplayTitle(
														{ id: item.contentId, metadata: item[choice]?.metadata },
														collection,
														{ defaultLocale },
													)}
													{item[choice]?.markdown && (
														<span className="block mt-1 whitespace-pre-line">
															{item[choice]?.markdown}
														</span>
													)}
												</span>
											)}
										</span>
									</label>
								))}
							</div>
						</fieldset>
					))}
				</div>
				<div className="p-4 border-t border-border flex items-center justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						disabled={syncing}
						className="px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover disabled:opacity-50"
					>
						{t('collections.list.syncDialog.later')}
					</button>
					<button
						type="button"
						onClick={() => onConfirm(choices)}
						disabled={syncing || !ready}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{t(syncing ? 'collections.list.sync.syncing' : 'collections.list.syncDialog.apply')}
					</button>
				</div>
			</div>
		</div>
	)
}
