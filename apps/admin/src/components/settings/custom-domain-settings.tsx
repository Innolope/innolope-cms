import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'

interface DnsRecord {
	name: string
	value: string
}

interface DomainStatus {
	domain: string | null
	verified: boolean
	verifiedAt: string | null
	dnsRecord: DnsRecord | null
	target: string
}

function CopyField({ label, value }: { label: string; value: string }) {
	const { t } = useTranslation()
	const [copied, setCopied] = useState(false)
	return (
		<div>
			<p className="text-[11px] text-text-secondary mb-1">{label}</p>
			<div className="flex items-center gap-2">
				<code className="flex-1 text-xs bg-surface px-3 py-2 rounded font-mono break-all border border-border">
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
					{copied ? t('settings.customDomain.copied') : t('settings.customDomain.copy')}
				</button>
			</div>
		</div>
	)
}

export function CustomDomainSettings() {
	const { t } = useTranslation()
	const { currentProject } = useAuth()
	const toast = useToast()
	const confirm = useConfirm()
	const [status, setStatus] = useState<DomainStatus | null>(null)
	const [loading, setLoading] = useState(true)
	const [domainInput, setDomainInput] = useState('')
	const [busy, setBusy] = useState(false)

	const projectId = currentProject?.id

	const load = useCallback(async () => {
		if (!projectId) return
		setLoading(true)
		try {
			setStatus(await api.get<DomainStatus>(`/api/v1/projects/${projectId}/custom-domain`))
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.customDomain.loadFailed'), 'error')
		} finally {
			setLoading(false)
		}
	}, [projectId, toast, t])

	useEffect(() => {
		load()
	}, [load])

	const saveDomain = async () => {
		if (!projectId || !domainInput.trim()) return
		setBusy(true)
		try {
			const next = await api.put<DomainStatus>(`/api/v1/projects/${projectId}/custom-domain`, {
				domain: domainInput.trim(),
			})
			setStatus(next)
			setDomainInput('')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.customDomain.saveFailed'), 'error')
		} finally {
			setBusy(false)
		}
	}

	const verify = async () => {
		if (!projectId) return
		setBusy(true)
		try {
			const next = await api.post<DomainStatus>(
				`/api/v1/projects/${projectId}/custom-domain/verify`,
				{},
			)
			setStatus(next)
			if (next.verified) toast(t('settings.customDomain.verifiedToast'), 'success')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.customDomain.verifyFailed'), 'error')
		} finally {
			setBusy(false)
		}
	}

	const remove = async () => {
		if (!projectId) return
		const ok = await confirm({
			title: t('settings.customDomain.removeConfirmTitle'),
			message: t('settings.customDomain.removeConfirmMessage'),
			confirmLabel: t('settings.customDomain.removeConfirmLabel'),
			danger: true,
		})
		if (!ok) return
		setBusy(true)
		try {
			await api.delete(`/api/v1/projects/${projectId}/custom-domain`)
			await load()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.customDomain.removeFailed'), 'error')
		} finally {
			setBusy(false)
		}
	}

	if (loading || !status) {
		return <p className="text-text-secondary text-sm">{t('common.loading')}</p>
	}

	return (
		<div className="space-y-5">
			<p className="text-sm text-text-secondary max-w-xl">
				{t('settings.customDomain.intro1')}{' '}
				<code className="font-mono text-xs">cms.yourcompany.com</code>
				{t('settings.customDomain.intro2')}
			</p>

			{/* No domain — add one */}
			{!status.domain && (
				<div className="space-y-2">
					<label htmlFor="cd-domain" className="block text-xs text-text-secondary">
						{t('settings.customDomain.domain')}
					</label>
					<div className="flex gap-2 max-w-md">
						<input
							id="cd-domain"
							type="text"
							value={domainInput}
							onChange={(e) => setDomainInput(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && saveDomain()}
							placeholder="cms.yourcompany.com"
							className="flex-1 px-3 py-2 bg-input border border-border-strong rounded text-sm text-text font-mono focus:outline-none focus:border-border-strong"
						/>
						<button
							type="button"
							onClick={saveDomain}
							disabled={busy || !domainInput.trim()}
							className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
						>
							{t('settings.customDomain.addDomain')}
						</button>
					</div>
				</div>
			)}

			{/* Domain configured */}
			{status.domain && (
				<div className="space-y-4">
					<div className="flex items-center justify-between gap-4 max-w-xl px-4 py-3 rounded-lg border border-border bg-surface-alt">
						<div className="min-w-0">
							<p className="text-sm font-medium text-text font-mono truncate">{status.domain}</p>
							<p className="text-xs mt-0.5">
								{status.verified ? (
									<span className="text-success">{t('settings.customDomain.verifiedAndLive')}</span>
								) : (
									<span className="text-warning">
										{t('settings.customDomain.pendingVerification')}
									</span>
								)}
							</p>
						</div>
						<button
							type="button"
							onClick={remove}
							disabled={busy}
							className="shrink-0 px-3 py-1.5 rounded text-sm font-medium border border-danger/50 text-danger hover:bg-danger/10 disabled:opacity-50"
						>
							{t('settings.customDomain.remove')}
						</button>
					</div>

					{!status.verified && (
						<div className="max-w-xl space-y-4 rounded-lg border border-border bg-surface-muted p-4">
							<div>
								<p className="text-sm font-medium text-text mb-1">
									{t('settings.customDomain.step1Title')}
								</p>
								<p className="text-xs text-text-muted mb-3">
									{t('settings.customDomain.step1Desc')}
								</p>
								{status.dnsRecord && (
									<div className="space-y-2">
										<CopyField
											label={t('settings.customDomain.txtRecordName')}
											value={status.dnsRecord.name}
										/>
										<CopyField
											label={t('settings.customDomain.txtRecordValue')}
											value={status.dnsRecord.value}
										/>
									</div>
								)}
							</div>
							<div>
								<p className="text-sm font-medium text-text mb-1">
									{t('settings.customDomain.step2Title')}
								</p>
								<p className="text-xs text-text-muted mb-3">
									{t('settings.customDomain.step2Desc1')}{' '}
									<strong>{t('settings.customDomain.dnsOnly')}</strong>
									{t('settings.customDomain.step2Desc2')}
								</p>
								<CopyField
									label={t('settings.customDomain.cnameLabel', { domain: status.domain })}
									value={status.target}
								/>
							</div>
							<button
								type="button"
								onClick={verify}
								disabled={busy}
								className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
							>
								{busy
									? t('settings.customDomain.checking')
									: t('settings.customDomain.verifyDomain')}
							</button>
						</div>
					)}

					{status.verified && (
						<div className="max-w-xl rounded-lg border border-border bg-surface-muted p-4 space-y-2">
							<p className="text-sm text-text">
								{t('settings.customDomain.signInAt')}{' '}
								<a
									href={`https://${status.domain}`}
									target="_blank"
									rel="noopener noreferrer"
									className="font-mono text-xs text-btn-primary hover:underline"
								>
									https://{status.domain}
								</a>
								.
							</p>
							<p className="text-xs text-text-muted">
								{t('settings.customDomain.cnameReminder1')}{' '}
								<code className="font-mono">{status.domain}</code>{' '}
								{t('settings.customDomain.cnameReminder2')}{' '}
								<code className="font-mono">{status.target}</code>
								{t('settings.customDomain.cnameReminder3')}{' '}
								<strong>{t('settings.customDomain.dnsOnly')}</strong>
								{t('settings.customDomain.cnameReminder4')}
							</p>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
