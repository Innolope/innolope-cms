import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/accept-invite')({
	component: AcceptInvite,
})

function AcceptInvite() {
	const { t } = useTranslation()
	const navigate = useNavigate()
	const params = new URLSearchParams(window.location.search)
	const token = params.get('token')

	const [status, setStatus] = useState<'loading' | 'success' | 'register' | 'error'>('loading')
	const [message, setMessage] = useState('')
	const [registerEmail, setRegisterEmail] = useState('')

	useEffect(() => {
		if (!token) {
			setStatus('error')
			setMessage(t('acceptInvite.errors.noToken'))
			return
		}

		api
			.post<{ action?: string; email?: string; message: string }>('/api/v1/invites/accept', {
				token,
			})
			.then((res) => {
				if (res.action === 'register') {
					setStatus('register')
					setRegisterEmail(res.email || '')
					setMessage(res.message)
				} else {
					setStatus('success')
					setMessage(res.message)
					setTimeout(() => navigate({ to: '/' }), 2000)
				}
			})
			.catch((err) => {
				setStatus('error')
				setMessage(err instanceof Error ? err.message : t('acceptInvite.errors.failed'))
			})
	}, [token, navigate, t])

	return (
		<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
			<div className="w-full max-w-sm text-center">
				{status === 'loading' && (
					<p className="text-text-secondary">{t('acceptInvite.accepting')}</p>
				)}

				{status === 'success' && (
					<div className="space-y-3">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mx-auto">
							<span className="text-2xl">✓</span>
						</div>
						<p className="text-sm text-text">{message}</p>
						<p className="text-xs text-text-muted">{t('acceptInvite.redirecting')}</p>
					</div>
				)}

				{status === 'register' && (
					<div className="space-y-4">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mx-auto">
							<span className="text-2xl">✉️</span>
						</div>
						<p className="text-sm text-text">{message}</p>
						<p className="text-xs text-text-muted">
							<Trans
								i18nKey="acceptInvite.createAccountToJoin"
								values={{ email: registerEmail }}
								components={{ strong: <strong /> }}
							/>
						</p>
						<Link
							to="/login"
							className="inline-block px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
						>
							{t('acceptInvite.createAccount')}
						</Link>
					</div>
				)}

				{status === 'error' && (
					<div className="space-y-4">
						<div className="w-12 h-12 bg-danger-surface rounded-xl flex items-center justify-center mx-auto">
							<span className="text-2xl text-danger">!</span>
						</div>
						<p className="text-sm text-danger">{message}</p>
						<Link
							to="/login"
							className="text-xs text-text-secondary hover:text-text-muted transition-colors"
						>
							{t('acceptInvite.goToLogin')}
						</Link>
					</div>
				)}
			</div>
		</div>
	)
}
