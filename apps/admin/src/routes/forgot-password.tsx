import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../lib/api-client'

export const Route = createFileRoute('/forgot-password')({
	component: ForgotPassword,
})

function ForgotPassword() {
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
			setError(err instanceof Error ? err.message : 'Something went wrong')
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="text-center mb-8">
					<h1 className="text-2xl font-bold">Reset Password</h1>
					<p className="text-zinc-500 text-sm mt-1">
						Enter your email and we'll send a reset link.
					</p>
				</div>

				{sent ? (
					<div className="text-center space-y-4">
						<div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center mx-auto">
							<span className="text-xl">✉️</span>
						</div>
						<p className="text-sm text-zinc-400">
							If an account exists for <strong>{email}</strong>, you'll receive a reset link shortly.
						</p>
						<Link
							to="/login"
							className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
						>
							Back to login
						</Link>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label className="block text-xs text-zinc-500 mb-1.5">Email</label>
							<input
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
								placeholder="your@email.com"
								autoFocus
							/>
						</div>

						{error && (
							<p className="text-sm text-red-400 bg-red-950/50 px-3 py-2 rounded">{error}</p>
						)}

						<button
							type="submit"
							disabled={submitting}
							className="w-full py-2.5 bg-white text-black rounded-lg text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors"
						>
							{submitting ? 'Sending...' : 'Send Reset Link'}
						</button>

						<Link
							to="/login"
							className="block text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
						>
							Back to login
						</Link>
					</form>
				)}
			</div>
		</div>
	)
}
