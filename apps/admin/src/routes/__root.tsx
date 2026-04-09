import { createRootRoute, Link, Outlet, useNavigate, useLocation } from '@tanstack/react-router'
import { useAuth, AuthProvider } from '../lib/auth'
import { ThemeProvider } from '../lib/theme'
import { LicenseProvider } from '../components/license-gate'
import { ProjectSelector } from '../components/project-selector'
import { useEffect, useState } from 'react'
import { api } from '../lib/api-client'

export const Route = createRootRoute({
	component: RootWithAuth,
})

function RootWithAuth() {
	return (
		<ThemeProvider>
			<AuthProvider>
				<LicenseProvider>
					<AuthGate />
				</LicenseProvider>
			</AuthProvider>
		</ThemeProvider>
	)
}

function AuthGate() {
	const { user, loading, currentProject } = useAuth()
	const navigate = useNavigate()
	const location = useLocation()
	const publicPaths = ['/login', '/forgot-password', '/reset-password', '/accept-invite']
	const isPublicPage = publicPaths.some((p) => location.pathname.startsWith(p))

	useEffect(() => {
		if (!loading && !user && !isPublicPage) {
			navigate({ to: '/login' })
		}
	}, [user, loading, isPublicPage, navigate])

	if (loading) {
		return (
			<div className="min-h-screen bg-bg flex items-center justify-center text-text-muted">
				Loading...
			</div>
		)
	}

	if (!user && !isPublicPage) return null
	if (isPublicPage) return <Outlet />
	if (!currentProject) return <NoProjectView />

	return <AppLayout />
}

function NoProjectView() {
	const { user, logout } = useAuth()
	const { refreshProjects } = useAuth()

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
		<div className="min-h-screen bg-bg flex items-center justify-center p-4">
			<div className="w-full max-w-sm text-center">
				<h1 className="text-2xl font-bold text-text">Welcome, {user?.name}</h1>
				<p className="text-text-secondary text-sm mt-2 mb-6">Create your first project to get started.</p>
				<div className="flex gap-2">
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && create()}
						placeholder="Project name"
						className="flex-1 px-3 py-2.5 bg-input border border-border-strong rounded-lg text-sm text-text focus:outline-none focus:border-border-strong"
						autoFocus
					/>
					<button
						type="button"
						onClick={create}
						disabled={creating}
						className="px-4 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						Create
					</button>
				</div>
				<button
					type="button"
					onClick={logout}
					className="mt-4 text-xs text-text-muted hover:text-text-secondary"
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
		<div className="flex h-screen bg-bg text-text">
			<aside className="w-64 bg-surface border-r border-border flex flex-col">
				<div className="p-3 border-b border-border">
					<ProjectSelector />
				</div>
				<nav className="flex-1 p-3 space-y-0.5">
					<NavLink to="/dashboard" label="Dashboard" />
					<NavLink to="/content" label="Content" />
					<NavLink to="/collections" label="Collections" />
					<NavLink to="/media" label="Media" />
					<NavLink to="/settings" label="Settings" />
				</nav>
				<div className="p-4 border-t border-border">
					<div className="flex items-center justify-between">
						<div className="min-w-0">
							<p className="text-sm truncate text-text">{user?.name}</p>
							<p className="text-xs text-text-muted truncate">{user?.email}</p>
						</div>
						<button
							type="button"
							onClick={handleLogout}
							className="text-xs text-text-muted hover:text-text-secondary shrink-0 ml-2"
						>
							Logout
						</button>
					</div>
					<p className="text-[10px] text-text-faint mt-2">v0.1.0</p>
				</div>
			</aside>
			<main className="flex-1 overflow-auto bg-bg">
				<Outlet />
			</main>
		</div>
	)
}

function NavLink({ to, label }: { to: string; label: string }) {
	return (
		<Link
			to={to}
			className="block px-3 py-2 rounded-md text-sm text-text-secondary transition-colors hover:bg-surface-alt hover:text-text"
			activeProps={{ className: 'bg-surface-alt text-text font-medium' }}
		>
			{label}
		</Link>
	)
}
