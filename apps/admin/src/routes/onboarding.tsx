import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useLicense } from '../components/license-gate'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/onboarding')({
	component: Onboarding,
})

const ONBOARDED_KEY = 'innolope_onboarded'

const TIERS: { name: string; tagline: string; accent: string; features: string[] }[] = [
	{
		name: 'Community',
		tagline: 'Free, self-hosted',
		accent: 'text-text',
		features: [
			'Unlimited collections & content',
			'REST API & TypeScript SDK',
			'MCP server for AI agents',
			'Team accounts & roles',
		],
	},
	{
		name: 'Pro',
		tagline: 'For growing teams',
		accent: 'text-violet-400',
		features: [
			'AI writing assistant',
			'Semantic search',
			'Media library & Unsplash',
			'Webhooks & content scheduling',
			'Multiple projects',
		],
	},
	{
		name: 'Enterprise',
		tagline: 'For organizations',
		accent: 'text-amber-400',
		features: ['SSO — SAML & OIDC', 'Audit log', 'Custom roles', 'White-label', 'Review workflows'],
	},
]

function Onboarding() {
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
			setError('Paste your license key, or skip for now.')
			return
		}
		setError('')
		setSubmitting(true)
		try {
			await api.put('/api/v1/license', { key })
			await license.refreshLicense()
			finish()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not activate license.')
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
						<h1 className="text-3xl font-bold mb-3">Welcome to Innolope CMS</h1>
						<p className="text-text-secondary max-w-md mx-auto mb-8">
							Your account is ready. Let's take a quick look at what you can do — and activate a
							license if you have one.
						</p>
						<button
							type="button"
							onClick={() => setStep(1)}
							className="px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
						>
							Get Started
						</button>
					</div>
				)}

				{step === 1 && (
					<div>
						<h1 className="text-2xl font-bold text-center mb-2">Choose how far you go</h1>
						<p className="text-text-secondary text-center mb-8">
							Innolope CMS is fully functional for free. Pro and Enterprise unlock more.
						</p>
						<div className="grid md:grid-cols-3 gap-4 mb-8">
							{TIERS.map((tier) => (
								<div
									key={tier.name}
									className="rounded-xl border border-border bg-surface p-5 flex flex-col"
								>
									<p className={`text-sm font-semibold ${tier.accent}`}>{tier.name}</p>
									<p className="text-xs text-text-muted mb-4">{tier.tagline}</p>
									<ul className="space-y-2 text-sm">
										{tier.features.map((f) => (
											<li key={f} className="flex gap-2 text-text-secondary">
												<span className="text-text-muted">•</span>
												{f}
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
								Back
							</button>
							<button
								type="button"
								onClick={() => setStep(2)}
								className="px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
							>
								Continue
							</button>
						</div>
					</div>
				)}

				{step === 2 && (
					<div className="max-w-md mx-auto text-center">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mb-4 mx-auto">
							<span className="text-2xl">✨</span>
						</div>
						<h1 className="text-2xl font-bold mb-2">Activate your license</h1>
						<p className="text-text-secondary mb-6">
							Have a Pro or Enterprise key? Paste it below to unlock paid features. You can always
							do this later from Settings.
						</p>
						<textarea
							value={keyInput}
							onChange={(e) => {
								setKeyInput(e.target.value)
								setError('')
							}}
							rows={3}
							placeholder="ink-lic_..."
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
								{submitting ? 'Verifying...' : 'Activate & Continue'}
							</button>
							<button
								type="button"
								onClick={finish}
								disabled={submitting}
								className="text-sm text-text-secondary hover:text-text disabled:opacity-50"
							>
								Skip — continue on Community
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
