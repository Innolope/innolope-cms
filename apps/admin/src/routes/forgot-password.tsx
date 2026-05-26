import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/forgot-password')({
	component: ForgotPassword,
})

function ForgotPassword() {
	const { t } = useTranslation()
	const [email, setEmail] = useState('')
	const [sent, setSent] = useState(false)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState('')

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError('')
		setSubmitting(true)
		try {
			await api.post('/api/v1/auth/forgot-password', { email })
			setSent(true)
		} catch (err) {
			setError(err instanceof Error ? err.message : t('forgotPassword.errors.generic'))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="text-center mb-8">
					<h1 className="text-2xl font-bold">{t('forgotPassword.title')}</h1>
					<p className="text-text-secondary text-sm mt-1">{t('forgotPassword.subtitle')}</p>
				</div>

				{sent ? (
					<div className="text-center space-y-4">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mx-auto">
							<span className="text-xl">✉️</span>
						</div>
						<p className="text-sm text-text-muted">
							<Trans
								i18nKey="forgotPassword.sentMessage"
								values={{ email }}
								components={{ strong: <strong /> }}
							/>
						</p>
						<Link
							to="/login"
							className="text-xs text-text-secondary hover:text-text-muted transition-colors"
						>
							{t('forgotPassword.backToLogin')}
						</Link>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label htmlFor="fp-email" className="block text-xs text-text-secondary mb-1.5">
								{t('forgotPassword.email')}
							</label>
							<input
								id="fp-email"
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								className="w-full px-3 py-2.5 bg-input border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
								placeholder={t('forgotPassword.emailPlaceholder')}
								autoFocus
							/>
						</div>

						{error && (
							<p className="text-sm text-danger bg-danger-surface px-3 py-2 rounded">{error}</p>
						)}

						<button
							type="submit"
							disabled={submitting}
							className="w-full py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50 transition-colors"
						>
							{submitting ? t('forgotPassword.sending') : t('forgotPassword.sendResetLink')}
						</button>

						<Link
							to="/login"
							className="block text-center text-xs text-text-secondary hover:text-text-muted transition-colors"
						>
							{t('forgotPassword.backToLogin')}
						</Link>
					</form>
				)}
			</div>
		</div>
	)
}
