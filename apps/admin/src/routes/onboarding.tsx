import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLicense } from '../components/license-gate'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/onboarding')({
	component: Onboarding,
})

const ONBOARDED_KEY = 'innolope_onboarded'

interface TierDef {
	id: 'community' | 'pro' | 'enterprise'
	accent: string
	featureKeys: string[]
}

const TIERS: TierDef[] = [
	{
		id: 'community',
		accent: 'text-text',
		featureKeys: ['unlimited', 'restApi', 'mcpServer', 'teamAccounts'],
	},
	{
		id: 'pro',
		accent: 'text-violet-400',
		featureKeys: ['aiAssistant', 'semanticSearch', 'mediaLibrary', 'webhooks', 'multiProjects'],
	},
	{
		id: 'enterprise',
		accent: 'text-amber-400',
		featureKeys: ['sso', 'auditLog', 'customRoles', 'whiteLabel', 'reviewWorkflows'],
	},
]

function Onboarding() {
	const { t } = useTranslation()
	const navigate = useNavigate()
	const license = useLicense()
	const [step, setStep] = useState(0)
	const [keyInput, setKeyInput] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState('')

	// Onboarding runs once, right after first-admin registration.
	useEffect(() => {
		if (localStorage.getItem(ONBOARDED_KEY)) navigate({ to: '/' })
	}, [navigate])

	const finish = () => {
		localStorage.setItem(ONBOARDED_KEY, '1')
		navigate({ to: '/' })
	}

	const activate = async () => {
		const key = keyInput.trim()
		if (!key) {
			setError(t('onboarding.errors.pasteOrSkip'))
			return
		}
		setError('')
		setSubmitting(true)
		try {
			await api.put('/api/v1/license', { key })
			await license.refreshLicense()
			finish()
		} catch (err) {
			setError(err instanceof Error ? err.message : t('onboarding.errors.activateFailed'))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
			<div className="w-full max-w-3xl">
				{/* Step indicator */}
				<div className="flex justify-center gap-2 mb-8">
					{[0, 1, 2].map((s) => (
						<span
							key={s}
							className={`h-1.5 rounded-full transition-all ${
								s === step ? 'w-8 bg-text' : 'w-4 bg-border'
							}`}
						/>
					))}
				</div>

				{step === 0 && (
					<div className="text-center">
						<img src="/logo.svg" alt="Innolope CMS" className="w-12 h-12 mx-auto mb-5" />
						<h1 className="text-3xl font-bold mb-3">{t('onboarding.welcome')}</h1>
						<p className="text-text-secondary max-w-md mx-auto mb-8">{t('onboarding.intro')}</p>
						<button
							type="button"
							onClick={() => setStep(1)}
							className="px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
						>
							{t('onboarding.getStarted')}
						</button>
					</div>
				)}

				{step === 1 && (
					<div>
						<h1 className="text-2xl font-bold text-center mb-2">{t('onboarding.chooseTitle')}</h1>
						<p className="text-text-secondary text-center mb-8">
							{t('onboarding.chooseSubtitle')}
						</p>
						<div className="grid md:grid-cols-3 gap-4 mb-8">
							{TIERS.map((tier) => (
								<div
									key={tier.id}
									className="rounded-xl border border-border bg-surface p-5 flex flex-col"
								>
									<p className={`text-sm font-semibold ${tier.accent}`}>
										{t(`onboarding.tiers.${tier.id}.name`)}
									</p>
									<p className="text-xs text-text-muted mb-4">
										{t(`onboarding.tiers.${tier.id}.tagline`)}
									</p>
									<ul className="space-y-2 text-sm">
										{tier.featureKeys.map((fk) => (
											<li key={fk} className="flex gap-2 text-text-secondary">
												<span className="text-text-muted">•</span>
												{t(`onboarding.tiers.${tier.id}.features.${fk}`)}
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
						<div className="flex justify-center gap-3">
							<button
								type="button"
								onClick={() => setStep(0)}
								className="px-5 py-2.5 bg-btn-secondary rounded-lg text-sm hover:bg-btn-secondary-hover transition-colors"
							>
								{t('onboarding.back')}
							</button>
							<button
								type="button"
								onClick={() => setStep(2)}
								className="px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
							>
								{t('onboarding.continue')}
							</button>
						</div>
					</div>
				)}

				{step === 2 && (
					<div className="max-w-md mx-auto text-center">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mb-4 mx-auto">
							<span className="text-2xl">✨</span>
						</div>
						<h1 className="text-2xl font-bold mb-2">{t('onboarding.activateTitle')}</h1>
						<p className="text-text-secondary mb-6">{t('onboarding.activateSubtitle')}</p>
						<textarea
							value={keyInput}
							onChange={(e) => {
								setKeyInput(e.target.value)
								setError('')
							}}
							rows={3}
							placeholder={t('onboarding.licensePlaceholder')}
							className="w-full px-3 py-2 bg-input border border-border rounded-lg text-sm font-mono text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong resize-none"
						/>
						{error && (
							<p className="mt-2 text-sm text-danger bg-danger-surface px-3 py-2 rounded text-left">
								{error}
							</p>
						)}
						<div className="mt-5 flex flex-col gap-3">
							<button
								type="button"
								onClick={activate}
								disabled={submitting}
								className="w-full py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
							>
								{submitting ? t('onboarding.verifying') : t('onboarding.activateAndContinue')}
							</button>
							<button
								type="button"
								onClick={finish}
								disabled={submitting}
								className="text-sm text-text-secondary hover:text-text disabled:opacity-50"
							>
								{t('onboarding.skip')}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
