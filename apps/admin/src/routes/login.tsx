import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/auth'
import { type FirebaseGoogleConfig, firebaseGoogleIdToken } from '../lib/firebase-auth'

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
export function safeNextParam(search: string = window.location.search): string {
	const raw = new URLSearchParams(search).get('next')
	if (!raw) return '/'
	let decoded: string
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		return '/'
	}
	// Must be a path starting with `/`, must not start with `//` (protocol-relative)
	// or `/\` (browsers normalise the backslash to `//`), must carry no backslash
	// or control characters anywhere, and must not be the login flow itself.
	// Mirrors the API's sanitizeNext.
	if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/'
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being rejected
	if (decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded)) return '/'
	if (decoded.startsWith('/login')) return '/'
	return decoded
}

function LoginPage() {
	const { t } = useTranslation()
	const {
		user,
		login,
		register,
		registerWithInvite,
		loginWithGoogle,
		loading,
		domainLocked,
		domainProjectName,
	} = useAuth()
	const navigate = useNavigate()
	const searchParams = new URLSearchParams(window.location.search)
	const inviteToken = searchParams.get('invite') || ''
	const [mode, setMode] = useState<'login' | 'setup' | 'invite'>(inviteToken ? 'invite' : 'login')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [name, setName] = useState('')
	const [error, setError] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [checkingSetup, setCheckingSetup] = useState(true)
	const [ssoDiscovery, setSsoDiscovery] = useState<SsoDiscovery | null>(null)
	const [googleConfig, setGoogleConfig] = useState<FirebaseGoogleConfig | null>(null)

	// Redirect if already logged in — honor `?next=` so deep-link → login → original page works.
	useEffect(() => {
		// An invite may intentionally create/switch to a different account, so do
		// not bounce that flow away just because another CMS session is present.
		if (!loading && user && !inviteToken) {
			const next = safeNextParam()
			// Use a hard navigation: `next` may be any in-app path and we want a clean state
			// (e.g. cookies/CSRF freshly applied) on the destination.
			if (next === '/') navigate({ to: '/' })
			else window.location.href = next
		}
	}, [user, loading, navigate, inviteToken])

	// Check if first user needs to be created
	useEffect(() => {
		Promise.allSettled([
			fetch('/api/v1/auth/setup-status').then((r) => r.json()),
			fetch('/api/v1/auth/providers').then((r) => r.json()),
			inviteToken
				? fetch('/api/v1/invites/details', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ token: inviteToken }),
					}).then(async (response) => {
						const data = (await response.json()) as { email?: string; error?: string }
						if (!response.ok) throw new Error(data.error || 'Invalid or expired invite.')
						return data
					})
				: Promise.resolve(null),
		]).then(([setupResult, providerResult, inviteResult]) => {
			if (setupResult.status === 'fulfilled') {
				const data = setupResult.value as { needsSetup: boolean }
				setMode(inviteToken ? 'invite' : data.needsSetup ? 'setup' : 'login')
			}
			if (providerResult.status === 'fulfilled') {
				const data = providerResult.value as {
					google?: { enabled?: boolean; firebase?: FirebaseGoogleConfig }
				}
				if (data.google?.enabled && data.google.firebase) {
					setGoogleConfig(data.google.firebase)
				}
			}
			if (inviteResult.status === 'fulfilled' && inviteResult.value?.email) {
				setEmail(inviteResult.value.email)
			} else if (inviteResult.status === 'rejected') {
				setError(
					inviteResult.reason instanceof Error
						? inviteResult.reason.message
						: t('acceptInvite.errors.failed'),
				)
			}
			setCheckingSetup(false)
		})
	}, [inviteToken, t])

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError('')

		const trimmedEmail = email.trim()
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
			setError(t('login.errors.invalidEmail'))
			return
		}
		if (mode !== 'login' && !name.trim()) {
			setError(t('login.errors.enterName'))
			return
		}
		const passwordRequired = mode !== 'login' || !ssoDiscovery?.enforceSso
		if (passwordRequired && password.length < 8) {
			setError(t('login.errors.passwordTooShort'))
			return
		}

		setSubmitting(true)
		try {
			if (mode === 'setup') {
				await register(trimmedEmail, password, name.trim())
				navigate({ to: '/onboarding' })
			} else if (mode === 'invite') {
				await registerWithInvite(inviteToken, trimmedEmail, password, name.trim())
				window.location.href = '/'
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

	const handleGoogle = async () => {
		if (!googleConfig) return
		setError('')
		setSubmitting(true)
		try {
			const idToken = await firebaseGoogleIdToken(googleConfig)
			const result = await loginWithGoogle(idToken, inviteToken || undefined)
			if (result.needsOnboarding) {
				navigate({ to: '/onboarding' })
				return
			}
			const next = safeNextParam()
			window.location.href = next
		} catch (err) {
			const code = (err as { code?: string }).code
			if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
				setError(err instanceof Error ? err.message : t('login.errors.googleFailed'))
			}
		} finally {
			setSubmitting(false)
		}
	}

	// Email-domain discovery: when the user blurs the email field, check for a matching SSO connection
	const onEmailBlur = async () => {
		if (!email.includes('@') || mode !== 'login') return
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
							: mode === 'invite'
								? t('login.subtitle.invite')
								: domainLocked && domainProjectName
									? t('login.subtitle.signInToProject', { name: domainProjectName })
									: t('login.subtitle.signIn')}
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					{googleConfig && (
						<>
							<button
								type="button"
								onClick={handleGoogle}
								disabled={submitting}
								className="w-full py-2.5 bg-white text-gray-800 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
							>
								<svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4">
									<path
										fill="#4285F4"
										d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z"
									/>
									<path
										fill="#34A853"
										d="M12 22c2.7 0 4.98-.9 6.63-2.36l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.83-1.76-5.62-4.13H3.03v2.62A10 10 0 0 0 12 22Z"
									/>
									<path
										fill="#FBBC05"
										d="M6.38 13.93A6 6 0 0 1 6.07 12c0-.67.12-1.32.31-1.93V7.45H3.03A10 10 0 0 0 2 12c0 1.61.39 3.14 1.03 4.55l3.35-2.62Z"
									/>
									<path
										fill="#EA4335"
										d="M12 5.94c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.97 5.45l3.35 2.62C7.17 7.7 9.39 5.94 12 5.94Z"
									/>
								</svg>
								{t(mode === 'login' ? 'login.continueWithGoogle' : 'login.signUpWithGoogle')}
							</button>
							<div className="flex items-center gap-3 text-xs text-text-muted">
								<span className="h-px flex-1 bg-border" />
								<span>{t('login.orContinueWithEmail')}</span>
								<span className="h-px flex-1 bg-border" />
							</div>
						</>
					)}
					{mode !== 'login' && (
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
							readOnly={mode === 'invite'}
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
									: mode === 'invite'
										? t('login.createAccount')
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
