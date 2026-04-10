import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/accept-invite')({
	component: AcceptInvite,
})

function AcceptInvite() {
	const navigate = useNavigate()
	const params = new URLSearchParams(window.location.search)
	const token = params.get('token')

	const [status, setStatus] = useState<'loading' | 'success' | 'register' | 'error'>('loading')
	const [message, setMessage] = useState('')
	const [registerEmail, setRegisterEmail] = useState('')

	useEffect(() => {
		if (!token) {
			setStatus('error')
			setMessage('No invite token provided.')
			return
		}

		api.post<{ action?: string; email?: string; message: string }>('/api/v1/invites/accept', { token })
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
				setMessage(err instanceof Error ? err.message : 'Failed to accept invite.')
			})
	}, [token, navigate])

	return (
		<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
			<div className="w-full max-w-sm text-center">
				{status === 'loading' && (
					<p className="text-text-secondary">Accepting invite...</p>
				)}

				{status === 'success' && (
					<div className="space-y-3">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mx-auto">
							<span className="text-2xl">✓</span>
						</div>
						<p className="text-sm text-text">{message}</p>
						<p className="text-xs text-text-muted">Redirecting...</p>
					</div>
				)}

				{status === 'register' && (
					<div className="space-y-4">
						<div className="w-12 h-12 bg-surface-alt rounded-xl flex items-center justify-center mx-auto">
							<span className="text-2xl">✉️</span>
						</div>
						<p className="text-sm text-text">{message}</p>
						<p className="text-xs text-text-muted">
							Create an account with <strong>{registerEmail}</strong> to join.
						</p>
						<Link
							to="/login"
							className="inline-block px-6 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover transition-colors"
						>
							Create Account
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
							Go to login
						</Link>
					</div>
				)}
			</div>
		</div>
	)
}
