import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { useLicense } from '../license-gate'

const FEATURE_KEYS: Record<string, string> = {
	sso: 'settings.license.features.sso',
	'audit-log': 'settings.license.features.auditLog',
	'ai-assistant': 'settings.license.features.aiAssistant',
	'multiple-projects': 'settings.license.features.multipleProjects',
	webhooks: 'settings.license.features.webhooks',
	scheduling: 'settings.license.features.scheduling',
	'custom-roles': 'settings.license.features.customRoles',
	'white-label': 'settings.license.features.whiteLabel',
	'review-workflows': 'settings.license.features.reviewWorkflows',
	'media-integrations': 'settings.license.features.mediaIntegrations',
}

const PLAN_KEYS: Record<string, string> = {
	community: 'settings.license.plans.community',
	pro: 'settings.license.plans.pro',
	enterprise: 'settings.license.plans.enterprise',
}

interface LicenseApiInfo {
	plan: 'community' | 'pro' | 'enterprise'
}

export function LicenseSettings() {
	const { t } = useTranslation()
	const license = useLicense()
	const toast = useToast()
	const confirm = useConfirm()
	const [keyInput, setKeyInput] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState('')

	const planLabel = (plan: string) => (PLAN_KEYS[plan] ? t(PLAN_KEYS[plan]) : plan)
	const featureLabel = (feature: string) =>
		FEATURE_KEYS[feature] ? t(FEATURE_KEYS[feature]) : feature

	const activate = async () => {
		const key = keyInput.trim()
		if (!key) {
			setError(t('settings.license.pasteFirst'))
			return
		}
		setError('')
		setSubmitting(true)
		try {
			const result = await api.put<LicenseApiInfo>('/api/v1/license', { key })
			await license.refreshLicense()
			setKeyInput('')
			toast(t('settings.license.activatedToast', { plan: planLabel(result.plan) }), 'success')
		} catch (err) {
			setError(err instanceof Error ? err.message : t('settings.license.activateFailed'))
		} finally {
			setSubmitting(false)
		}
	}

	const remove = async () => {
		const ok = await confirm({
			title: t('settings.license.removeConfirmTitle'),
			message: t('settings.license.removeConfirmMessage'),
			confirmLabel: t('settings.license.removeConfirmLabel'),
			danger: true,
		})
		if (!ok) return
		setSubmitting(true)
		try {
			await api.delete('/api/v1/license')
			await license.refreshLicense()
			toast(t('settings.license.removedToast'), 'success')
		} catch (err) {
			toast(err instanceof Error ? err.message : t('settings.license.removeFailed'), 'error')
		} finally {
			setSubmitting(false)
		}
	}

	if (license.cloudMode) {
		return <p className="text-sm text-text-secondary">{t('settings.license.cloudNotice')}</p>
	}

	return (
		<div className="space-y-8 max-w-2xl">
			{/* Current plan */}
			<div className="rounded-lg bg-surface-alt p-5">
				<div className="flex items-center justify-between">
					<div>
						<p className="text-xs text-text-secondary uppercase tracking-wider mb-1">
							{t('settings.license.currentPlan')}
						</p>
						<p className="text-xl font-bold">{planLabel(license.plan)}</p>
					</div>
					{license.valid && (
						<span className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded">
							{t('settings.license.licensedBadge')}
						</span>
					)}
				</div>
				{license.valid && (
					<dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
						{license.org && (
							<div>
								<dt className="text-text-secondary">{t('settings.license.organization')}</dt>
								<dd className="font-medium">{license.org}</dd>
							</div>
						)}
						{license.expiresAt && (
							<div>
								<dt className="text-text-secondary">{t('settings.license.expires')}</dt>
								<dd className="font-medium">{new Date(license.expiresAt).toLocaleDateString()}</dd>
							</div>
						)}
					</dl>
				)}
				{license.valid && license.features.length > 0 && (
					<div className="mt-4">
						<p className="text-text-secondary text-sm mb-2">
							{t('settings.license.unlockedFeatures')}
						</p>
						<ul className="flex flex-wrap gap-2">
							{license.features.map((f) => (
								<li
									key={f}
									className="px-2 py-1 text-xs rounded bg-surface border border-border text-text-secondary"
								>
									{featureLabel(f)}
								</li>
							))}
						</ul>
					</div>
				)}
				{!license.valid && (
					<p className="mt-3 text-sm text-text-secondary">
						{t('settings.license.communityNotice')}
					</p>
				)}
			</div>

			{/* Activate */}
			<div>
				<h3 className="font-semibold text-sm mb-1">
					{license.valid ? t('settings.license.replaceKey') : t('settings.license.activateLicense')}
				</h3>
				<p className="text-sm text-text-secondary mb-3">
					{t('settings.license.activateDesc')} <code className="text-xs">ink-lic_</code>.
				</p>
				<input
					type="text"
					value={keyInput}
					onChange={(e) => {
						setKeyInput(e.target.value)
						setError('')
					}}
					placeholder="ink-lic_..."
					className="w-full px-3 py-2 bg-input border border-border rounded-lg text-sm font-mono text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
				/>
				{error && (
					<p className="mt-2 text-sm text-danger bg-danger-surface px-3 py-2 rounded">{error}</p>
				)}
				<div className="mt-3 flex items-center gap-3">
					<button
						type="button"
						onClick={activate}
						disabled={submitting}
						className="px-4 py-2 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
					>
						{submitting ? t('settings.license.verifying') : t('settings.license.activateButton')}
					</button>
					{license.valid && (
						<button
							type="button"
							onClick={remove}
							disabled={submitting}
							className="text-sm text-danger hover:opacity-80 disabled:opacity-50"
						>
							{t('settings.license.removeLicense')}
						</button>
					)}
					<a
						href="https://innolope.com/apps/cms#pricing"
						target="_blank"
						rel="noopener noreferrer"
						className="ml-auto text-sm text-text-secondary hover:text-text"
					>
						{t('settings.license.viewPlans')}
					</a>
				</div>
			</div>
		</div>
	)
}
