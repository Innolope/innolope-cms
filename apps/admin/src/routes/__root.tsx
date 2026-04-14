import { createRootRoute, Link, Outlet, useNavigate, useLocation } from '@tanstack/react-router'
import { useAuth, AuthProvider } from '../lib/auth'
import { ThemeProvider } from '../lib/theme'
import { LicenseProvider } from '../components/license-gate'
import { ToastProvider, useToast } from '../lib/toast'
import { CollectionsProvider, useCollections } from '../lib/collections'
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
					<CollectionsProvider>
						<ToastProvider>
							<AuthGate />
						</ToastProvider>
					</CollectionsProvider>
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
			<div className="min-h-screen bg-bg flex items-center justify-center">
				<div className="flex gap-1.5">
					<span className="w-2 h-2 bg-text-muted rounded-full animate-pulse" />
					<span className="w-2 h-2 bg-text-muted rounded-full animate-pulse [animation-delay:150ms]" />
					<span className="w-2 h-2 bg-text-muted rounded-full animate-pulse [animation-delay:300ms]" />
				</div>
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
	const toast = useToast()

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
			toast(err instanceof Error ? err.message : 'Failed', 'error')
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
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem('innolope_sidebar') === 'collapsed')

	const toggleSidebar = () => {
		const next = !collapsed
		setCollapsed(next)
		localStorage.setItem('innolope_sidebar', next ? 'collapsed' : 'expanded')
	}

	const handleLogout = () => {
		logout()
		navigate({ to: '/login' })
	}

	return (
		<div className="flex h-screen bg-bg text-text relative">
			<aside className={`${collapsed ? 'w-16' : 'w-64'} bg-surface border-r border-border flex flex-col transition-all duration-200 shrink-0`}>
				{/* Project selector / favicon */}
				{collapsed ? (
					<div className="p-3 border-b border-border flex justify-center">
						<img src="/favicon.png" alt="" className="w-7 h-7" />
					</div>
				) : (
					<div className="p-4 border-b border-border">
						<ProjectSelector />
					</div>
				)}

				{/* Collapse toggle — centered on sidebar edge */}
				<button
					type="button"
					onClick={toggleSidebar}
					className={`absolute top-1/2 -translate-y-1/2 z-10 w-6 h-6 rounded-md bg-surface border border-border shadow-sm flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-alt transition-colors ${collapsed ? 'left-[47px]' : 'left-[243px]'}`}
					title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<polyline points={collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
					</svg>
				</button>

				{/* Navigation */}
				<nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
					{collapsed ? (
						<>
							<CollapsedNavLink to="/dashboard" title="Dashboard" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>} />
							<div className="my-2 border-t border-border" />
							<CollectionNavCollapsed />
							<div className="my-2 border-t border-border" />
							<CollapsedNavLink to="/media" title="Media" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>} />
							<CollapsedNavLink to="/settings" title="Project Settings" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>} />
						</>
					) : (
						<>
							<NavLink to="/dashboard" label="Dashboard" />
							<div className="my-2 border-t border-border" />
							<p className="px-3 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Collections</p>
							<CollectionNavExpanded />
							<div className="my-2 border-t border-border" />
							<NavLink to="/media" label="Media" />
							<NavLink to="/settings" label="Project Settings" />
						</>
					)}
				</nav>

				{/* Footer */}
				<div className="p-3 border-t border-border">
					{collapsed ? (
						<div className="flex flex-col items-center gap-2">
							<Link to="/account" className="p-1.5 rounded-md text-text-muted hover:bg-surface-alt hover:text-text transition-colors" title="Account settings">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
							</Link>
							<button type="button" onClick={handleLogout} className="p-1.5 rounded-md text-text-muted hover:text-danger transition-colors" title="Logout">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
							</button>
						</div>
					) : (
						<>
							<div className="flex items-center justify-between">
								<div className="min-w-0">
									<p className="text-sm truncate text-text">{user?.name}</p>
									<p className="text-xs text-text-muted truncate">{user?.email}</p>
								</div>
								<Link to="/account" className="text-text-muted hover:text-text transition-colors shrink-0 ml-2" title="Account settings">
									<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.5" /><path d="M13.3 10.1a1.1 1.1 0 0 0 .2 1.2l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.67 1.01v.11a1.33 1.33 0 1 1-2.67 0v-.06A1.1 1.1 0 0 0 5.9 13.3a1.1 1.1 0 0 0-1.2.2l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1.01-.67h-.11a1.33 1.33 0 1 1 0-2.67h.06A1.1 1.1 0 0 0 2.7 5.9a1.1 1.1 0 0 0-.2-1.2l-.04-.04A1.33 1.33 0 1 1 4.34 2.78l.04.04a1.1 1.1 0 0 0 1.2.2h.05a1.1 1.1 0 0 0 .67-1.01v-.11a1.33 1.33 0 0 1 2.67 0v.06a1.1 1.1 0 0 0 .67 1.01 1.1 1.1 0 0 0 1.2-.2l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.2 1.2v.05a1.1 1.1 0 0 0 1.01.67h.11a1.33 1.33 0 0 1 0 2.67h-.06a1.1 1.1 0 0 0-1.01.67Z" /></svg>
								</Link>
							</div>
							<p className="text-[10px] text-text-faint mt-2">v0.1.0</p>
							<button type="button" onClick={handleLogout} className="flex items-center gap-1.5 text-text-faint hover:text-danger transition-colors mt-1.5" title="Logout">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
								<span className="text-[10px]">Logout</span>
							</button>
						</>
					)}
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

function CollapsedNavLink({ to, title, icon }: { to: string; title: string; icon: React.ReactNode }) {
	return (
		<Link
			to={to}
			className="flex items-center justify-center p-2 rounded-md text-text-secondary transition-colors hover:bg-surface-alt hover:text-text"
			activeProps={{ className: 'bg-surface-alt text-text' }}
			title={title}
		>
			{icon}
		</Link>
	)
}

function CollectionNavExpanded() {
	const { collections, loading } = useCollections()
	const location = useLocation()

	if (loading) {
		return (
			<div className="space-y-1 px-3">
				{[1, 2, 3].map((i) => (
					<div key={i} className="h-8 bg-surface-alt rounded-md animate-pulse" />
				))}
			</div>
		)
	}

	return (
		<div className="space-y-0.5">
			{collections.map((col) => {
				const isActive = location.pathname.startsWith(`/collections/${col.name}`)
				return (
					<Link
						key={col.id}
						to="/collections/$slug"
						params={{ slug: col.name }}
						className={`flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors ${
							isActive
								? 'bg-surface-alt text-text font-medium'
								: 'text-text-secondary hover:bg-surface-alt hover:text-text'
						}`}
					>
						<span className="truncate flex items-center gap-1.5">
							{col.source === 'external' && (
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-50"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
							)}
							{col.label}
						</span>
						{col.contentCount > 0 && (
							<span className="text-[10px] text-text-muted shrink-0 ml-2">{col.contentCount}</span>
						)}
					</Link>
				)
			})}
			<Link
				to="/collections/new"
				className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm text-text-muted transition-colors hover:bg-surface-alt hover:text-text-secondary"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
				New Collection
			</Link>
		</div>
	)
}

function CollectionNavCollapsed() {
	const { collections } = useCollections()

	return (
		<div className="space-y-0.5">
			{collections.map((col) => (
				<Link
					key={col.id}
					to="/collections/$slug"
					params={{ slug: col.name }}
					className="flex items-center justify-center p-2 rounded-md text-text-secondary transition-colors hover:bg-surface-alt hover:text-text"
					title={`${col.label} (${col.contentCount})`}
				>
					<span className="text-xs font-semibold uppercase w-5 h-5 flex items-center justify-center">
						{col.label.charAt(0)}
					</span>
				</Link>
			))}
			<Link
				to="/collections/new"
				className="flex items-center justify-center p-2 rounded-md text-text-muted transition-colors hover:bg-surface-alt hover:text-text-secondary"
				title="New Collection"
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
			</Link>
		</div>
	)
}
