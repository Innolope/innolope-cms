import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'

export const Route = createFileRoute('/login')({
	component: LoginPage,
})

interface SsoDiscovery {
	id: string
	slug: string
	projectId: string
	protocol: 'saml' | 'oidc'
	enforceSso: boolean
	name: string
}

/**
 * Read `?next=` from the URL and reject anything that isn't an internal path.
 * Guards against open-redirect (e.g. `?next=https://evil.com`) and avoids bouncing
 * the user right back into the login flow.
 */
function safeNextParam(): string {
	const raw = new URLSearchParams(window.location.search).get('next')
	if (!raw) return '/'
	let decoded: string
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		return '/'
	}
	// Must be a path starting with `/`, must not start with `//` (protocol-relative),
	// and must not be the login flow itself.
	if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/'
	if (decoded.startsWith('/login')) return '/'
	return decoded
}

function LoginPage() {
	const { t } = useTranslation()
	const { user, login, register, loading, domainLocked, domainProjectName } = useAuth()
	const navigate = useNavigate()
	const [mode, setMode] = useState<'login' | 'setup'>('login')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [name, setName] = useState('')
	const [error, setError] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [checkingSetup, setCheckingSetup] = useState(true)
	const [ssoDiscovery, setSsoDiscovery] = useState<SsoDiscovery | null>(null)

	// Redirect if already logged in — honor `?next=` so deep-link → login → original page works.
	useEffect(() => {
		if (!loading && user) {
			const next = safeNextParam()
			// Use a hard navigation: `next` may be any in-app path and we want a clean state
			// (e.g. cookies/CSRF freshly applied) on the destination.
			if (next === '/') navigate({ to: '/' })
			else window.location.href = next
		}
	}, [user, loading, navigate])

	// Check if first user needs to be created
	useEffect(() => {
		fetch('/api/v1/auth/setup-status')
			.then((r) => r.json())
			.then((data: { needsSetup: boolean }) => {
				setMode(data.needsSetup ? 'setup' : 'login')
			})
			.catch(() => setMode('login'))
			.finally(() => setCheckingSetup(false))
	}, [])

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError('')

		const trimmedEmail = email.trim()
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
			setError(t('login.errors.invalidEmail'))
			return
		}
		if (mode === 'setup' && !name.trim()) {
			setError(t('login.errors.enterName'))
			return
		}
		const passwordRequired = mode === 'setup' || !ssoDiscovery?.enforceSso
		if (passwordRequired && password.length < 8) {
			setError(t('login.errors.passwordTooShort'))
			return
		}

		setSubmitting(true)
		try {
			if (mode === 'setup') {
				await register(trimmedEmail, password, name.trim())
				navigate({ to: '/onboarding' })
			} else {
				await login(trimmedEmail, password)
				const next = safeNextParam()
				if (next === '/') navigate({ to: '/' })
				else window.location.href = next
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t('login.errors.authFailed'))
		} finally {
			setSubmitting(false)
		}
	}

	// Email-domain discovery: when the user blurs the email field, check for a matching SSO connection
	const onEmailBlur = async () => {
		if (!email.includes('@') || mode === 'setup') return
		try {
			const res = await fetch(`/api/v1/auth/sso/discover?email=${encodeURIComponent(email)}`, {
				credentials: 'include',
			})
			if (res.ok) {
				const data = (await res.json()) as SsoDiscovery
				setSsoDiscovery(data)
			} else {
				setSsoDiscovery(null)
			}
		} catch {
			setSsoDiscovery(null)
		}
	}

	const startSso = () => {
		if (!ssoDiscovery) return
		const next = safeNextParam()
		const initiateUrl = `/api/v1/auth/sso/${encodeURIComponent(ssoDiscovery.slug)}/initiate?next=${encodeURIComponent(next)}`
		window.location.href = initiateUrl
	}

	if (loading || checkingSetup) {
		return (
			<div className="min-h-screen bg-bg flex items-center justify-center text-text-secondary">
				{t('common.loading')}
			</div>
		)
	}

	return (
		<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="text-center mb-8">
					<img src="/logo.svg" alt="Innolope CMS" className="w-10 h-10 mx-auto mb-4 " />
					<h1 className="text-2xl font-bold text-text">
						{domainLocked && domainProjectName ? domainProjectName : 'Innolope CMS'}
					</h1>
					<p className="text-text-secondary text-sm mt-1">
						{mode === 'setup'
							? t('login.subtitle.setup')
							: domainLocked && domainProjectName
								? t('login.subtitle.signInToProject', { name: domainProjectName })
								: t('login.subtitle.signIn')}
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					{mode === 'setup' && (
						<div>
							<label htmlFor="login-name" className="block text-xs text-text-secondary mb-1.5">
								{t('login.fields.yourName')}
							</label>
							<input
								id="login-name"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								className="w-full px-3 py-2.5 bg-input border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
								placeholder={t('login.placeholders.name')}
								autoFocus
							/>
						</div>
					)}
					<div>
						<label htmlFor="login-email" className="block text-xs text-text-secondary mb-1.5">
							{t('login.fields.email')}
						</label>
						<input
							id="login-email"
							type="email"
							value={email}
							onChange={(e) => {
								setEmail(e.target.value)
								setSsoDiscovery(null)
							}}
							onBlur={onEmailBlur}
							required
							className="w-full px-3 py-2.5 bg-input border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
							placeholder={t('login.placeholders.email')}
							autoFocus={mode === 'login'}
						/>
					</div>
					{!(ssoDiscovery?.enforceSso && mode === 'login') && (
						<div>
							<label htmlFor="login-password" className="block text-xs text-text-secondary mb-1.5">
								{t('login.fields.password')}
							</label>
							<input
								id="login-password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required={!ssoDiscovery?.enforceSso}
								minLength={8}
								className="w-full px-3 py-2.5 bg-input border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
								placeholder={t('login.placeholders.password')}
							/>
						</div>
					)}

					{error && (
						<p className="text-sm text-danger bg-danger-surface px-3 py-2 rounded">{error}</p>
					)}

					{ssoDiscovery && mode === 'login' ? (
						<button
							type="button"
							onClick={startSso}
							className="w-full py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
						>
							{t('login.continueWithSso', { name: ssoDiscovery.name })}
						</button>
					) : (
						<button
							type="submit"
							disabled={submitting}
							className="w-full py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
						>
							{submitting
								? t('login.pleaseWait')
								: mode === 'setup'
									? t('login.createAdminAccount')
									: t('login.signIn')}
						</button>
					)}
					{ssoDiscovery && !ssoDiscovery.enforceSso && mode === 'login' && (
						<p className="text-xs text-center text-text-muted">{t('login.orUsePassword')}</p>
					)}
				</form>
				{mode === 'login' && (
					<Link
						to="/forgot-password"
						className="block text-center text-xs text-text-secondary hover:text-text-muted mt-4 transition-colors"
					>
						{t('login.forgotPassword')}
					</Link>
				)}
			</div>
		</div>
	)
}
