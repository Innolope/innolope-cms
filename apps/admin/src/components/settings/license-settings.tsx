import { useState } from 'react'
import { api } from '../../lib/api-client'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { useLicense } from '../license-gate'

const FEATURE_LABELS: Record<string, string> = {
	sso: 'Single Sign-On (SAML & OIDC)',
	'audit-log': 'Audit Log',
	'ai-assistant': 'AI Assistant & Semantic Search',
	'multiple-projects': 'Multiple Projects',
	webhooks: 'Webhooks',
	scheduling: 'Content Scheduling',
	'custom-roles': 'Custom Roles',
	'white-label': 'White-Label',
	'review-workflows': 'Review Workflows',
	'media-integrations': 'Media Library',
}

const PLAN_LABELS: Record<string, string> = {
	community: 'Community',
	pro: 'Pro',
	enterprise: 'Enterprise',
}

interface LicenseApiInfo {
	plan: 'community' | 'pro' | 'enterprise'
}

export function LicenseSettings() {
	const license = useLicense()
	const toast = useToast()
	const confirm = useConfirm()
	const [keyInput, setKeyInput] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState('')

	const activate = async () => {
		const key = keyInput.trim()
		if (!key) {
			setError('Paste your license key first.')
			return
		}
		setError('')
		setSubmitting(true)
		try {
			const result = await api.put<LicenseApiInfo>('/api/v1/license', { key })
			await license.refreshLicense()
			setKeyInput('')
			toast(`${PLAN_LABELS[result.plan] || result.plan} license activated.`, 'success')
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not activate license.')
		} finally {
			setSubmitting(false)
		}
	}

	const remove = async () => {
		const ok = await confirm({
			title: 'Remove license',
			message: 'Remove this license and revert to the Community tier?',
			confirmLabel: 'Remove',
			danger: true,
		})
		if (!ok) return
		setSubmitting(true)
		try {
			await api.delete('/api/v1/license')
			await license.refreshLicense()
			toast('License removed. Now running on the Community tier.', 'success')
		} catch (err) {
			toast(err instanceof Error ? err.message : 'Could not remove license.', 'error')
		} finally {
			setSubmitting(false)
		}
	}

	if (license.cloudMode) {
		return (
			<p className="text-sm text-text-secondary">
				This instance runs on Innolope Cloud — all features are included and no license key is
				needed.
			</p>
		)
	}

	return (
		<div className="space-y-8 max-w-2xl">
			{/* Current plan */}
			<div className="rounded-lg bg-surface-alt p-5">
				<div className="flex items-center justify-between">
					<div>
						<p className="text-xs text-text-secondary uppercase tracking-wider mb-1">
							Current plan
						</p>
						<p className="text-xl font-bold">{PLAN_LABELS[license.plan] || license.plan}</p>
					</div>
					{license.valid && (
						<span className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded">
							Licensed
						</span>
					)}
				</div>
				{license.valid && (
					<dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
						{license.org && (
							<div>
								<dt className="text-text-secondary">Organization</dt>
								<dd className="font-medium">{license.org}</dd>
							</div>
						)}
						{license.expiresAt && (
							<div>
								<dt className="text-text-secondary">Expires</dt>
								<dd className="font-medium">{new Date(license.expiresAt).toLocaleDateString()}</dd>
							</div>
						)}
					</dl>
				)}
				{license.valid && license.features.length > 0 && (
					<div className="mt-4">
						<p className="text-text-secondary text-sm mb-2">Unlocked features</p>
						<ul className="flex flex-wrap gap-2">
							{license.features.map((f) => (
								<li
									key={f}
									className="px-2 py-1 text-xs rounded bg-surface border border-border text-text-secondary"
								>
									{FEATURE_LABELS[f] || f}
								</li>
							))}
						</ul>
					</div>
				)}
				{!license.valid && (
					<p className="mt-3 text-sm text-text-secondary">
						You're on the free Community tier. Activate a license key below to unlock Pro and
						Enterprise features.
					</p>
				)}
			</div>

			{/* Activate */}
			<div>
				<h3 className="font-semibold text-sm mb-1">
					{license.valid ? 'Replace license key' : 'Activate a license'}
				</h3>
				<p className="text-sm text-text-secondary mb-3">
					Paste the license key from your Innolope CMS purchase. Keys start with{' '}
					<code className="text-xs">ink-lic_</code>.
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
						{submitting ? 'Verifying...' : 'Activate License'}
					</button>
					{license.valid && (
						<button
							type="button"
							onClick={remove}
							disabled={submitting}
							className="text-sm text-danger hover:opacity-80 disabled:opacity-50"
						>
							Remove license
						</button>
					)}
					<a
						href="https://innolope.com/apps/cms#pricing"
						target="_blank"
						rel="noopener noreferrer"
						className="ml-auto text-sm text-text-secondary hover:text-text"
					>
						View plans &amp; pricing
					</a>
				</div>
			</div>
		</div>
	)
}
