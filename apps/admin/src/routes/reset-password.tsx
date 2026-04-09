import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/reset-password')({
	component: ResetPassword,
})

function ResetPassword() {
	const navigate = useNavigate()
	const params = new URLSearchParams(window.location.search)
	const token = params.get('token')

	const [password, setPassword] = useState('')
	const [confirm, setConfirm] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState('')
	const [done, setDone] = useState(false)

	if (!token) {
		return (
			<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
				<div className="text-center">
					<p className="text-text-secondary">Invalid reset link.</p>
					<Link to="/login" className="text-xs text-text-muted hover:text-text-faint mt-2 block">
						Back to login
					</Link>
				</div>
			</div>
		)
	}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError('')
		if (password !== confirm) {
			setError('Passwords do not match.')
			return
		}
		setSubmitting(true)
		try {
			await api.post('/api/v1/auth/reset-password', { token, password })
			setDone(true)
			setTimeout(() => navigate({ to: '/login' }), 2000)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Reset failed')
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div className="min-h-screen bg-bg text-text flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="text-center mb-8">
					<h1 className="text-2xl font-bold">New Password</h1>
					<p className="text-text-secondary text-sm mt-1">Enter your new password.</p>
				</div>

				{done ? (
					<div className="text-center space-y-3">
						<p className="text-sm text-text">Password updated! Redirecting to login...</p>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label className="block text-xs text-text-secondary mb-1.5">New password</label>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								minLength={8}
								className="w-full px-3 py-2.5 bg-input border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
								placeholder="Min 8 characters"
								autoFocus
							/>
						</div>
						<div>
							<label className="block text-xs text-text-secondary mb-1.5">Confirm password</label>
							<input
								type="password"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								required
								minLength={8}
								className="w-full px-3 py-2.5 bg-input border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-border-strong"
								placeholder="Repeat password"
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
							{submitting ? 'Updating...' : 'Set New Password'}
						</button>
					</form>
				)}
			</div>
		</div>
	)
}
