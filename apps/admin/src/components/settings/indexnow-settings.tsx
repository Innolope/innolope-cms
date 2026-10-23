import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'
import { relativeTime } from '../../lib/relative-time'
import { useToast } from '../../lib/toast'

type SubmissionStatus = 'success' | 'retrying' | 'waiting' | 'failed'

interface Submission {
	id: string
	collectionId: string | null
	host: string
	urlCount: number
	sampleUrls: string[]
	status: SubmissionStatus
	statusCode: number | null
	message: string | null
	trigger: 'change' | 'resubmit'
	createdAt: string
}

interface IndexNowStatus {
	settings: { enabled: boolean; key: string | null; keyLocation: string | null }
	keyFiles: Array<{ host: string; url: string; path: string }>
	collections: Array<{
		id: string
		name: string
		label: string
		publicUrlTemplate: string | null
		pending: number
		waiting: number
		lastSubmission: Omit<Submission, 'id' | 'collectionId' | 'host' | 'sampleUrls'> | null
	}>
	recent: Submission[]
}

interface KeyCheck {
	host: string
	keyLocation: string
	ok: boolean
	statusCode: number | null
	message: string
}

const STATUS_CLASS: Record<SubmissionStatus, string> = {
	success: 'text-success',
	retrying: 'text-warning',
	waiting: 'text-warning',
	failed: 'text-danger',
}

function CopyValue({ value }: { value: string }) {
	const { t } = useTranslation()
	const [copied, setCopied] = useState(false)
	return (
		<div className="flex items-center gap-2 min-w-0">
			<code className="flex-1 min-w-0 text-xs bg-surface px-3 py-2 rounded font-mono break-all border border-border">
				{value}
			</code>
			<button
				type="button"
				onClick={() => {
					navigator.clipboard.writeText(value)
					setCopied(true)
					setTimeout(() => setCopied(false), 2000)
				}}
				className="px-3 py-2 bg-btn-secondary text-text-secondary rounded text-xs hover:bg-btn-secondary-hover shrink-0"
			>
				{copied ? t('settings.indexNow.copied') : t('settings.indexNow.copy')}
			</button>
		</div>
	)
}

function StatusText({
	status,
	statusCode,
}: {
	status: SubmissionStatus
	statusCode: number | null
}) {
	const { t } = useTranslation()
	return (
		<span className={`${STATUS_CLASS[status]} font-medium`}>
			{t(`settings.indexNow.status.${status}`)}
			{statusCode ? ` · ${statusCode}` : ''}
		</span>
	)
}

export function IndexNowSettings() {
	const { t } = useTranslation()
	const { currentProject, refreshProjects } = useAuth()
	const toast = useToast()
	const confirm = useConfirm()
	const [status, setStatus] = useState<IndexNowStatus | null>(null)
	const [loading, setLoading] = useState(true)
	const [enabled, setEnabled] = useState(false)
	const [keyLocation, setKeyLocation] = useState('')
	const [saving, setSaving] = useState(false)
	const [checking, setChecking] = useState(false)
	const [checks, setChecks] = useState<KeyCheck[] | null>(null)
	const [resubmitting, setResubmitting] = useState<string | null>(null)

	const projectId = currentProject?.id

	const apply = useCallback((next: IndexNowStatus) => {
		setStatus(next)
		setEnabled(next.settings.enabled)
		setKeyLocation(next.settings.keyLocation ?? '')
	}, [])

	const load = useCallback(async () => {
		if (!projectId) return
		try {
			apply(await api.get<IndexNowStatus>('/api/v1/indexnow'))
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.indexNow.loadFailed'), 'error')
		} finally {
			setLoading(false)
		}
	}, [projectId, apply, toast, t])

	useEffect(() => {
		load()
	}, [load])

	// While URLs are queued, follow them out: the queue drains within seconds.
	const queued = status?.collections.some((c) => c.pending > 0) ?? false
	useEffect(() => {
		if (!queued) return
		const timer = setInterval(() => {
			api
				.get<IndexNowStatus>('/api/v1/indexnow')
				.then(setStatus)
				.catch(() => {})
		}, 10_000)
		return () => clearInterval(timer)
	}, [queued])

	const save = async (extra: Record<string, unknown> = {}) => {
		setSaving(true)
		try {
			apply(
				await api.put<IndexNowStatus>('/api/v1/indexnow', {
					enabled,
					keyLocation: keyLocation.trim() || null,
					...extra,
				}),
			)
			setChecks(null)
			toast(t('settings.indexNow.saved'), 'success')
			await refreshProjects()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.indexNow.saveFailed'), 'error')
		} finally {
			setSaving(false)
		}
	}

	const regenerate = async () => {
		const ok = await confirm({
			title: t('settings.indexNow.regenerateConfirmTitle'),
			message: t('settings.indexNow.regenerateConfirmMessage'),
			confirmLabel: t('settings.indexNow.regenerateConfirmLabel'),
			danger: true,
		})
		if (ok) await save({ regenerateKey: true })
	}

	const check = async () => {
		setChecking(true)
		try {
			setChecks((await api.post<{ results: KeyCheck[] }>('/api/v1/indexnow/verify', {})).results)
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.indexNow.checkFailed'), 'error')
		} finally {
			setChecking(false)
		}
	}

	const resubmit = async (collectionId: string) => {
		setResubmitting(collectionId)
		try {
			const result = await api.post<{ queued: number; skipped: number }>(
				`/api/v1/indexnow/collections/${collectionId}/resubmit`,
				{},
			)
			toast(t('settings.indexNow.resubmitted', { count: result.queued }), 'success')
			await load()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.indexNow.resubmitFailed'), 'error')
		} finally {
			setResubmitting(null)
		}
	}

	if (loading || !status) {
		return <p className="text-text-secondary text-sm">{t('common.loading')}</p>
	}

	const saved = status.settings
	const dirty = enabled !== saved.enabled || keyLocation.trim() !== (saved.keyLocation ?? '')
	const key = saved.key
	const collectionLabel = (id: string | null) =>
		status.collections.find((c) => c.id === id)?.label ?? t('settings.indexNow.deletedCollection')

	return (
		<div className="space-y-8 max-w-3xl">
			<p className="text-sm text-text-secondary max-w-xl">{t('settings.indexNow.intro')}</p>

			{/* Settings */}
			<div className="space-y-5">
				<label className="flex items-start gap-3 max-w-xl cursor-pointer">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
						className="mt-0.5 rounded"
					/>
					<span>
						<span className="block text-sm text-text font-medium">
							{t('settings.indexNow.enabled')}
						</span>
						<span className="block text-[11px] text-text-muted mt-0.5">
							{t('settings.indexNow.enabledHelp')}
						</span>
					</span>
				</label>

				<div className="max-w-xl">
					<p className="block text-xs text-text-secondary mb-1.5">{t('settings.indexNow.key')}</p>
					{key ? (
						<div className="flex items-center gap-2">
							<div className="flex-1 min-w-0">
								<CopyValue value={key} />
							</div>
							<button
								type="button"
								onClick={regenerate}
								disabled={saving}
								className="px-3 py-2 rounded text-xs border border-border text-text-secondary hover:text-text hover:border-border-strong disabled:opacity-50 shrink-0"
							>
								{t('settings.indexNow.regenerate')}
							</button>
						</div>
					) : (
						<p className="text-xs text-text-muted">{t('settings.indexNow.keyPending')}</p>
					)}
				</div>

				<div className="max-w-xl">
					<label
						htmlFor="indexnow-key-location"
						className="block text-xs text-text-secondary mb-1.5"
					>
						{t('settings.indexNow.keyLocation')}
					</label>
					<input
						id="indexnow-key-location"
						type="url"
						value={keyLocation}
						onChange={(e) => setKeyLocation(e.target.value)}
						placeholder={t('settings.indexNow.keyLocationPlaceholder', {
							key: key ?? '<key>',
						})}
						className="w-full px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
					/>
					<p className="text-[11px] text-text-muted mt-1">
						{t('settings.indexNow.keyLocationHelp')}
					</p>
				</div>

				{(dirty || !key) && (
					<button
						type="button"
						onClick={() => save()}
						disabled={saving}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{saving ? t('settings.indexNow.saving') : t('settings.indexNow.save')}
					</button>
				)}
			</div>

			{/* Key files the site must serve */}
			{key && (
				<div className="rounded-lg border border-border bg-surface p-4 space-y-4 max-w-xl">
					<div>
						<p className="text-sm font-medium text-text">{t('settings.indexNow.keyFilesTitle')}</p>
						<p className="text-xs text-text-muted mt-1">{t('settings.indexNow.keyFilesHelp')}</p>
					</div>
					{status.keyFiles.length === 0 ? (
						<p className="text-xs text-text-secondary">{t('settings.indexNow.keyFilesNone')}</p>
					) : (
						<div className="space-y-3">
							{status.keyFiles.map((file) => {
								const result = checks?.find((c) => c.host === file.host)
								return (
									<div key={file.host} className="space-y-1.5">
										<p className="text-[11px] text-text-secondary">{file.host}</p>
										<CopyValue value={file.url} />
										{result && (
											<p className={`text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>
												{result.message}
											</p>
										)}
									</div>
								)
							})}
							<div>
								<p className="text-[11px] text-text-secondary mb-1">
									{t('settings.indexNow.keyFileContent')}
								</p>
								<CopyValue value={key} />
							</div>
						</div>
					)}
					<p className="text-[11px] text-text-muted">
						{t('settings.indexNow.buildHint1')}{' '}
						<code className="font-mono">GET /api/v1/indexnow/key</code>{' '}
						{t('settings.indexNow.buildHint2')}
					</p>
					{status.keyFiles.length > 0 && (
						<button
							type="button"
							onClick={check}
							disabled={checking}
							className="px-3 py-1.5 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover disabled:opacity-50"
						>
							{checking ? t('settings.indexNow.checking') : t('settings.indexNow.check')}
						</button>
					)}
				</div>
			)}

			{/* Collections */}
			<div className="space-y-3">
				<div>
					<p className="text-sm font-medium text-text">{t('settings.indexNow.collectionsTitle')}</p>
					<p className="text-xs text-text-muted mt-1">{t('settings.indexNow.collectionsHelp')}</p>
				</div>
				{status.collections.length === 0 ? (
					<p className="text-xs text-text-secondary border border-dashed border-border rounded-lg px-4 py-3">
						{t('settings.indexNow.collectionsEmpty')}
					</p>
				) : (
					<div className="border border-border rounded-lg divide-y divide-border">
						{status.collections.map((c) => (
							<div key={c.id} className="flex items-start justify-between gap-4 px-4 py-3">
								<div className="min-w-0 space-y-1">
									<Link
										to="/collections/$slug/edit"
										params={{ slug: c.name }}
										className="text-sm font-medium text-text hover:underline"
									>
										{c.label}
									</Link>
									<p className="text-xs text-text-secondary font-mono break-all">
										{c.publicUrlTemplate}
									</p>
									<p className="text-xs text-text-muted">
										{c.lastSubmission ? (
											<>
												<StatusText
													status={c.lastSubmission.status}
													statusCode={c.lastSubmission.statusCode}
												/>
												{' · '}
												{t('settings.indexNow.urls', { count: c.lastSubmission.urlCount })}
												{' · '}
												{relativeTime(c.lastSubmission.createdAt)}
											</>
										) : (
											t('settings.indexNow.never')
										)}
										{c.pending > 0 && (
											<>
												{' · '}
												<span className={c.waiting > 0 ? 'text-warning' : ''}>
													{c.waiting > 0
														? t('settings.indexNow.held', { count: c.waiting })
														: t('settings.indexNow.queued', { count: c.pending })}
												</span>
											</>
										)}
									</p>
									{c.lastSubmission?.message && c.lastSubmission.status !== 'success' && (
										<p className="text-xs text-text-secondary break-words">
											{c.lastSubmission.message}
										</p>
									)}
								</div>
								<button
									type="button"
									onClick={() => resubmit(c.id)}
									disabled={!saved.enabled || resubmitting !== null}
									title={saved.enabled ? undefined : t('settings.indexNow.resubmitDisabled')}
									className="px-3 py-1.5 bg-btn-secondary text-text rounded text-xs font-medium hover:bg-btn-secondary-hover disabled:opacity-50 shrink-0"
								>
									{resubmitting === c.id
										? t('settings.indexNow.resubmitting')
										: t('settings.indexNow.resubmit')}
								</button>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Recent submissions */}
			<div className="space-y-3">
				<p className="text-sm font-medium text-text">{t('settings.indexNow.recentTitle')}</p>
				{status.recent.length === 0 ? (
					<p className="text-xs text-text-secondary">{t('settings.indexNow.recentEmpty')}</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-xs">
							<thead>
								<tr className="text-left text-text-muted">
									<th className="font-normal py-1.5 pr-4">{t('settings.indexNow.colWhen')}</th>
									<th className="font-normal py-1.5 pr-4">
										{t('settings.indexNow.colCollection')}
									</th>
									<th className="font-normal py-1.5 pr-4">{t('settings.indexNow.colUrls')}</th>
									<th className="font-normal py-1.5 pr-4">{t('settings.indexNow.colResult')}</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border">
								{status.recent.map((s) => (
									<tr key={s.id} className="align-top">
										<td
											className="py-2 pr-4 whitespace-nowrap text-text-secondary"
											title={new Date(s.createdAt).toLocaleString()}
										>
											{relativeTime(s.createdAt)}
										</td>
										<td className="py-2 pr-4 text-text">
											{collectionLabel(s.collectionId)}
											{s.trigger === 'resubmit' && (
												<span className="text-text-muted">
													{' '}
													· {t('settings.indexNow.trigger.resubmit')}
												</span>
											)}
										</td>
										<td className="py-2 pr-4 whitespace-nowrap text-text-secondary">
											<span title={s.sampleUrls.join('\n')}>
												{t('settings.indexNow.urls', { count: s.urlCount })}
											</span>
										</td>
										<td className="py-2 pr-4">
											<StatusText status={s.status} statusCode={s.statusCode} />
											{s.status !== 'success' && s.message && (
												<span className="block text-text-secondary break-words max-w-sm">
													{s.message}
												</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	)
}
