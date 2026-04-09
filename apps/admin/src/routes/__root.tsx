import { createRootRoute, Link, Outlet, useNavigate, useLocation } from '@tanstack/react-router'
import { useAuth, AuthProvider } from '../lib/auth'
import { LicenseProvider } from '../components/license-gate'
import { ProjectSelector } from '../components/project-selector'
import { useEffect } from 'react'

export const Route = createRootRoute({
	component: RootWithAuth,
})

function RootWithAuth() {
	return (
		<AuthProvider>
			<LicenseProvider>
				<AuthGate />
			</LicenseProvider>
		</AuthProvider>
	)
}

function AuthGate() {
	const { user, loading, currentProject } = useAuth()
	const navigate = useNavigate()
	const location = useLocation()
	const isLoginPage = location.pathname === '/login'

	useEffect(() => {
		if (!loading && !user && !isLoginPage) {
			navigate({ to: '/login' })
		}
	}, [user, loading, isLoginPage, navigate])

	if (loading) {
		return (
			<div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-500">
				Loading...
			</div>
		)
	}

	if (!user && !isLoginPage) return null
	if (isLoginPage) return <Outlet />

	// Show project creation if user has no projects
	if (!currentProject) return <NoProjectView />

	return <AppLayout />
}

function NoProjectView() {
	const { user, logout } = useAuth()
	const { refreshProjects } = useAuth()
	const navigate = useNavigate()

	const [name, setName] = useState('')
	const [creating, setCreating] = useState(false)

	const create = async () => {
		if (!name.trim()) return
		setCreating(true)
		try {
			const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
			await api.post('/api/v1/projects', { name, slug })
			await refreshProjects()
			window.location.reload()
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed')
		} finally {
			setCreating(false)
		}
	}

	return (
		<div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
			<div className="w-full max-w-sm text-center">
				<h1 className="text-2xl font-bold text-white">Welcome, {user?.name}</h1>
				<p className="text-zinc-500 text-sm mt-2 mb-6">Create your first project to get started.</p>
				<div className="flex gap-2">
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && create()}
						placeholder="Project name"
						className="flex-1 px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-zinc-600"
						autoFocus
					/>
					<button
						type="button"
						onClick={create}
						disabled={creating}
						className="px-4 py-2.5 bg-white text-black rounded-lg text-sm font-medium hover:bg-zinc-200 disabled:opacity-50"
					>
						Create
					</button>
				</div>
				<button
					type="button"
					onClick={logout}
					className="mt-4 text-xs text-zinc-600 hover:text-zinc-400"
				>
					Logout
				</button>
			</div>
		</div>
	)
}

function AppLayout() {
	const { user, logout } = useAuth()
	const navigate = useNavigate()

	const handleLogout = () => {
		logout()
		navigate({ to: '/login' })
	}

	return (
		<div className="flex h-screen bg-zinc-950 text-zinc-100">
			<aside className="w-64 border-r border-zinc-800 flex flex-col">
				<div className="p-3 border-b border-zinc-800">
					<ProjectSelector />
				</div>
				<nav className="flex-1 p-3 space-y-1">
					<NavLink to="/" label="Dashboard" />
					<NavLink to="/content" label="Content" />
					<NavLink to="/collections" label="Collections" />
					<NavLink to="/media" label="Media" />
					<NavLink to="/settings" label="Settings" />
				</nav>
				<div className="p-4 border-t border-zinc-800">
					<div className="flex items-center justify-between">
						<div className="min-w-0">
							<p className="text-sm truncate">{user?.name}</p>
							<p className="text-xs text-zinc-600 truncate">{user?.email}</p>
						</div>
						<button
							type="button"
							onClick={handleLogout}
							className="text-xs text-zinc-500 hover:text-zinc-300 shrink-0 ml-2"
						>
							Logout
						</button>
					</div>
					<p className="text-[10px] text-zinc-700 mt-2">v0.1.0</p>
				</div>
			</aside>
			<main className="flex-1 overflow-auto">
				<Outlet />
			</main>
		</div>
	)
}

function NavLink({ to, label }: { to: string; label: string }) {
	return (
		<Link
			to={to}
			className="block px-3 py-2 rounded-md text-sm transition-colors hover:bg-zinc-800"
			activeProps={{ className: 'bg-zinc-800 text-white' }}
		>
			{label}
		</Link>
	)
}

// Need these imports for NoProjectView
import { useState } from 'react'
import { api } from '../lib/api-client'
