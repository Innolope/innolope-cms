import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useAuth } from '../lib/auth'

export const Route = createFileRoute('/login')({
	component: LoginPage,
})

function LoginPage() {
	const { user, login, register, loading } = useAuth()
	const navigate = useNavigate()
	const [mode, setMode] = useState<'login' | 'setup'>('login')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [name, setName] = useState('')
	const [error, setError] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [checkingSetup, setCheckingSetup] = useState(true)

	// Redirect if already logged in
	useEffect(() => {
		if (!loading && user) navigate({ to: '/' })
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
		setSubmitting(true)
		try {
			if (mode === 'setup') {
				await register(email, password, name)
			} else {
				await login(email, password)
			}
			navigate({ to: '/' })
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Authentication failed')
		} finally {
			setSubmitting(false)
		}
	}

	if (loading || checkingSetup) {
		return (
			<div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-500">
				Loading...
			</div>
		)
	}

	return (
		<div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="text-center mb-8">
					<img
						src="/logo.svg"
						alt="Innolope CMS"
						className="w-10 h-10 mx-auto mb-4 invert brightness-200"
					/>
					<h1 className="text-2xl font-bold text-white">Innolope CMS</h1>
					<p className="text-zinc-500 text-sm mt-1">
						{mode === 'setup' ? 'Welcome! Set up your Innolope CMS account to get started.' : 'Sign in to your Innolope CMS account'}
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					{mode === 'setup' && (
						<div>
							<label className="block text-xs text-zinc-500 mb-1.5">Your name</label>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
								className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
								placeholder="Inna Lope"
								autoFocus
							/>
						</div>
					)}
					<div>
						<label className="block text-xs text-zinc-500 mb-1.5">Email</label>
						<input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
							placeholder="admin@example.com"
							autoFocus={mode === 'login'}
						/>
					</div>
					<div>
						<label className="block text-xs text-zinc-500 mb-1.5">Password</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							minLength={8}
							className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
							placeholder="Min 8 characters"
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
						{submitting
							? 'Please wait...'
							: mode === 'setup'
								? 'Create Admin Account'
								: 'Sign In'}
					</button>
				</form>
				{mode === 'login' && (
					<Link
						to="/forgot-password"
						className="block text-center text-xs text-zinc-500 hover:text-zinc-300 mt-4 transition-colors"
					>
						Forgot password?
					</Link>
				)}
			</div>
		</div>
	)
}
