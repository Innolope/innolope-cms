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
			<div className="min-h-screen bg-zinc-50 text-zinc-900 flex items-center justify-center p-4">
				<div className="text-center">
					<p className="text-zinc-500">Invalid reset link.</p>
					<Link to="/login" className="text-xs text-zinc-400 hover:text-zinc-300 mt-2 block">
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
		<div className="min-h-screen bg-zinc-50 text-zinc-900 flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="text-center mb-8">
					<h1 className="text-2xl font-bold">New Password</h1>
					<p className="text-zinc-500 text-sm mt-1">Enter your new password.</p>
				</div>

				{done ? (
					<div className="text-center space-y-3">
						<p className="text-sm text-zinc-700">Password updated! Redirecting to login...</p>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label className="block text-xs text-zinc-500 mb-1.5">New password</label>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								minLength={8}
								className="w-full px-3 py-2.5 bg-white border border-zinc-200 rounded-lg text-sm text-zinc-900 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
								placeholder="Min 8 characters"
								autoFocus
							/>
						</div>
						<div>
							<label className="block text-xs text-zinc-500 mb-1.5">Confirm password</label>
							<input
								type="password"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								required
								minLength={8}
								className="w-full px-3 py-2.5 bg-white border border-zinc-200 rounded-lg text-sm text-zinc-900 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
								placeholder="Repeat password"
							/>
						</div>

						{error && (
							<p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
						)}

						<button
							type="submit"
							disabled={submitting}
							className="w-full py-2.5 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 transition-colors"
						>
							{submitting ? 'Updating...' : 'Set New Password'}
						</button>
					</form>
				)}
			</div>
		</div>
	)
}
