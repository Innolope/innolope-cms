import { createRootRoute, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
// AuthGate no longer uses navigate (it does a hard redirect for the cross-boundary case),
// but other components below still import it from the same line above.
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasFeature, LicenseProvider, ProBadge, useLicense } from '../components/license-gate'
import { ProjectSelector } from '../components/project-selector'
import { api, loginUrlPreservingNext } from '../lib/api-client'
import { AuthProvider, useAuth } from '../lib/auth'
import {
	CollectionsProvider,
	isCollectionVisibleInSidebar,
	useCollections,
} from '../lib/collections'
import { ConfirmProvider } from '../lib/confirm'
import { LocaleProvider } from '../lib/locale'
import { ThemeProvider } from '../lib/theme'
import { ToastProvider, useToast } from '../lib/toast'

export const Route = createRootRoute({
	component: RootWithAuth,
})

function RootWithAuth() {
	return (
		<ThemeProvider>
			<AuthProvider>
				<LocaleProvider>
					<LicenseProvider>
						<CollectionsProvider>
							<ToastProvider>
								<ConfirmProvider>
									<AuthGate />
								</ConfirmProvider>
							</ToastProvider>
						</CollectionsProvider>
					</LicenseProvider>
				</LocaleProvider>
			</AuthProvider>
		</ThemeProvider>
	)
}

function AuthGate() {
	const { user, loading, currentProject, domainLocked, domainProjectName } = useAuth()
	const location = useLocation()
	const publicPaths = ['/login', '/forgot-password', '/reset-password', '/accept-invite']
	const isPublicPage = publicPaths.some((p) => location.pathname.startsWith(p))

	useEffect(() => {
		if (!loading && !user && !isPublicPage) {
			// Preserve the originally-requested URL so login can return the user there.
			// Use a hard redirect — TanStack's typed navigate balks at the dynamic `next` query
			// string we build here, and we're crossing an auth boundary anyway.
			window.location.href = loginUrlPreservingNext()
		}
	}, [user, loading, isPublicPage])

	if (loading) {
		// Show a skeleton shell rather than a blank full-page spinner. Hard
		// reloads of any in-app route now look like the layout the user is
		// about to see, with the same sidebar width and header band, instead
		// of a full-screen flash of three dots. The spinner moves into the
		// content area, which is where the actual loading happens anyway.
		return <ShellSkeleton />
	}

	if (!user && !isPublicPage) return null
	if (isPublicPage) return <Outlet />
	// On a custom domain the project is fixed; a signed-in non-member gets no access.
	if (domainLocked && !currentProject) {
		return <DomainAccessDeniedView projectName={domainProjectName} />
	}
	// Onboarding runs right after first-admin registration, before any project exists.
	if (location.pathname.startsWith('/onboarding')) return <Outlet />
	if (!currentProject) return <NoProjectView />

	return <AppLayout />
}

/**
 * Layout-preserving loading state. Mirrors `AppLayout`'s grid (sidebar + main
 * content) so that hard reloads and slow auth checks don't flash a blank
 * full-screen spinner before the shell paints. The actual loading affordance
 * (three pulsing dots) sits inside the content area where new data will land.
 */
function ShellSkeleton() {
	return (
		<div className="flex h-screen bg-bg">
			<aside className="w-60 shrink-0 bg-bg border-r border-border" aria-hidden="true" />
			<main className="flex-1 overflow-auto bg-bg flex items-center justify-center">
				<div className="flex gap-1.5" role="status" aria-label="Loading">
					<span className="w-2 h-2 bg-text-muted rounded-full animate-pulse" />
					<span className="w-2 h-2 bg-text-muted rounded-full animate-pulse [animation-delay:150ms]" />
					<span className="w-2 h-2 bg-text-muted rounded-full animate-pulse [animation-delay:300ms]" />
				</div>
			</main>
		</div>
	)
}

function DomainAccessDeniedView({ projectName }: { projectName: string | null }) {
	const { t } = useTranslation()
	const { user, logout } = useAuth()
	return (
		<div className="min-h-screen bg-bg flex items-center justify-center p-4">
			<div className="w-full max-w-sm text-center">
				<h1 className="text-2xl font-bold text-text">{t('domainAccess.noAccess')}</h1>
				<p className="text-text-secondary text-sm mt-2 mb-6">
					{t(projectName ? 'domainAccess.bodyNamed' : 'domainAccess.bodyUnnamed', {
						email: user?.email,
						projectName,
					})}
				</p>
				<button
					type="button"
					onClick={logout}
					className="px-4 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover"
				>
					{t('common.signOut')}
				</button>
			</div>
		</div>
	)
}

function NoProjectView() {
	const { t } = useTranslation()
	const { user, logout } = useAuth()
	const { refreshProjects } = useAuth()
	const toast = useToast()

	const [name, setName] = useState('')
	const [creating, setCreating] = useState(false)

	const create = async () => {
		const trimmed = name.trim()
		if (!trimmed) return
		const slug = trimmed
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
		if (!slug) {
			toast(t('noProject.errors.invalidName'), 'error')
			return
		}
		setCreating(true)
		try {
			await api.post('/api/v1/projects', { name: trimmed, slug })
			await refreshProjects()
			window.location.reload()
		} catch (err) {
			toast(err instanceof Error ? err.message : t('common.failed'), 'error')
		} finally {
			setCreating(false)
		}
	}

	return (
		<div className="min-h-screen bg-bg flex items-center justify-center p-4">
			<div className="w-full max-w-sm text-center">
				<h1 className="text-2xl font-bold text-text">
					{t('noProject.welcome', { name: user?.name })}
				</h1>
				<p className="text-text-secondary text-sm mt-2 mb-6">{t('noProject.subtitle')}</p>
				<div className="flex gap-2">
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && create()}
						placeholder={t('noProject.projectNamePlaceholder')}
						className="flex-1 px-3 py-2.5 bg-input border border-border-strong rounded-lg text-sm text-text focus:outline-none focus:border-border-strong"
						autoFocus
					/>
					<button
						type="button"
						onClick={create}
						disabled={creating || !name.trim()}
						className="px-4 py-2.5 bg-btn-primary text-btn-primary-text rounded-lg text-sm font-medium hover:bg-btn-primary-hover disabled:opacity-50"
					>
						{t('common.create')}
					</button>
				</div>
				<button
					type="button"
					onClick={logout}
					className="mt-4 text-xs text-text-muted hover:text-text-secondary"
				>
					{t('common.logout')}
				</button>
			</div>
		</div>
	)
}

function AppLayout() {
	const { t } = useTranslation()
	const { user, logout } = useAuth()
	const license = useLicense()
	const mediaLocked = !hasFeature(license, 'media-integrations')
	const navigate = useNavigate()
	const { pathname } = useLocation()

	// Below this viewport width we switch to a tablet layout: the sidebar drops to
	// the icon rail so the content gets full width, and the toggle opens it as an
	// overlay drawer instead of pushing the content.
	const TABLET_BREAKPOINT = 1024
	const [isNarrow, setIsNarrow] = useState(
		() => typeof window !== 'undefined' && window.innerWidth < TABLET_BREAKPOINT,
	)
	const [mobileOpen, setMobileOpen] = useState(false)
	const [manualCollapsed, setManualCollapsed] = useState(
		() => localStorage.getItem('innolope_sidebar') === 'collapsed',
	)

	// Effective rail state used throughout the render: on tablet the rail shows
	// unless the drawer is open; on desktop it follows the user's manual choice.
	const collapsed = isNarrow ? !mobileOpen : manualCollapsed
	// True when the expanded sidebar floats over the content (tablet drawer).
	const overlay = isNarrow && mobileOpen

	useEffect(() => {
		const onResize = () => {
			const narrow = window.innerWidth < TABLET_BREAKPOINT
			setIsNarrow(narrow)
			if (!narrow) setMobileOpen(false)
		}
		window.addEventListener('resize', onResize)
		return () => window.removeEventListener('resize', onResize)
	}, [])

	// Close the tablet drawer whenever the route changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation; setter is stable.
	useEffect(() => {
		setMobileOpen(false)
	}, [pathname])

	const toggleSidebar = () => {
		if (isNarrow) {
			setMobileOpen((o) => !o)
			return
		}
		const next = !manualCollapsed
		setManualCollapsed(next)
		localStorage.setItem('innolope_sidebar', next ? 'collapsed' : 'expanded')
	}

	// Expanded-sidebar width is drag-resizable on desktop (the collapsed rail and
	// the tablet drawer stay fixed-width). Persisted across sessions and clamped.
	const SIDEBAR_MIN = 200
	const SIDEBAR_MAX = 480
	const [width, setWidth] = useState(() => {
		const stored = Number(localStorage.getItem('innolope_sidebar_width'))
		return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : 256
	})
	const [resizing, setResizing] = useState(false)

	useEffect(() => {
		if (!isNarrow && !manualCollapsed) {
			localStorage.setItem('innolope_sidebar_width', String(width))
		}
	}, [width, isNarrow, manualCollapsed])

	const startResize = (e: ReactMouseEvent) => {
		e.preventDefault()
		setResizing(true)
		const startX = e.clientX
		const startWidth = width
		const onMove = (ev: MouseEvent) => {
			setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX)))
		}
		const onUp = () => {
			setResizing(false)
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
	}

	const handleLogout = () => {
		logout()
		navigate({ to: '/login' })
	}

	return (
		<div className="flex h-screen bg-bg text-text relative">
			{/* Tablet drawer backdrop — tap to dismiss the floating sidebar. */}
			{overlay && (
				<button
					type="button"
					aria-label={t('nav.collapseSidebar')}
					onClick={() => setMobileOpen(false)}
					className="absolute inset-0 z-30 bg-black/40"
				/>
			)}
			<aside
				style={overlay ? { width: 256 } : collapsed ? undefined : { width }}
				className={`${collapsed ? 'w-16' : ''} bg-surface border-r border-border flex flex-col ${resizing ? '' : 'transition-all duration-200'} shrink-0 ${overlay ? 'absolute top-0 left-0 h-full z-40 shadow-2xl' : 'relative'}`}
			>
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

				{/* Drag handle to resize the expanded sidebar (desktop only; the rail and
				    the tablet drawer are fixed-width). */}
				{!isNarrow && !manualCollapsed && (
					<button
						type="button"
						aria-label={t('nav.resizeSidebar')}
						onMouseDown={startResize}
						className="absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-border-strong/50 active:bg-border-strong"
					/>
				)}

				{/* Collapse toggle — centered on sidebar edge, tracks the current width */}
				<button
					type="button"
					onClick={toggleSidebar}
					style={{ left: (collapsed ? 64 : overlay ? 256 : width) - 13 }}
					className="absolute top-1/2 -translate-y-1/2 z-30 w-6 h-6 rounded-md bg-surface border border-border shadow-sm flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-alt transition-colors"
					title={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points={collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
					</svg>
				</button>

				{/* Navigation */}
				<nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
					{collapsed ? (
						<>
							<CollapsedNavLink
								to="/dashboard"
								title={t('nav.dashboard')}
								icon={
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<rect x="3" y="3" width="7" height="7" />
										<rect x="14" y="3" width="7" height="7" />
										<rect x="14" y="14" width="7" height="7" />
										<rect x="3" y="14" width="7" height="7" />
									</svg>
								}
							/>
							<div className="my-2 border-t border-border" />
							<CollectionNavCollapsed />
							<div className="my-2 border-t border-border" />
							<CollapsedNavLink
								to="/media"
								title={t('nav.media')}
								icon={
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
										<circle cx="8.5" cy="8.5" r="1.5" />
										<polyline points="21 15 16 10 5 21" />
									</svg>
								}
							/>
							<CollapsedNavLink
								to="/settings"
								title={t('nav.settings')}
								icon={
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle cx="12" cy="12" r="3" />
										<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
									</svg>
								}
							/>
						</>
					) : (
						<>
							<NavLink to="/dashboard" label={t('nav.dashboard')} />
							<div className="my-2 border-t border-border" />
							<p className="px-3 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
								{t('nav.collections')}
							</p>
							<CollectionNavExpanded />
							<div className="my-2 border-t border-border" />
							<NavLink to="/media" label={t('nav.media')} proBadge={mediaLocked} />
							<NavLink to="/settings" label={t('nav.settings')} />
						</>
					)}
				</nav>

				{/* Footer */}
				<div className="p-3 border-t border-border">
					{collapsed ? (
						<div className="flex flex-col items-center gap-2">
							<Link
								to="/account"
								className="p-1.5 rounded-md text-text-muted hover:bg-surface-alt hover:text-text transition-colors"
								title={t('nav.accountSettings')}
							>
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
									<circle cx="12" cy="7" r="4" />
								</svg>
							</Link>
							<button
								type="button"
								onClick={handleLogout}
								className="p-1.5 rounded-md text-text-muted hover:text-danger transition-colors"
								title={t('common.logout')}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
									<polyline points="16 17 21 12 16 7" />
									<line x1="21" y1="12" x2="9" y2="12" />
								</svg>
							</button>
						</div>
					) : (
						<>
							<div className="flex items-center justify-between">
								<div className="min-w-0">
									<p className="text-sm truncate text-text">{user?.name}</p>
									<p className="text-xs text-text-muted truncate">{user?.email}</p>
								</div>
								<Link
									to="/account"
									className="text-text-muted hover:text-text transition-colors shrink-0 ml-2"
									title={t('nav.accountSettings')}
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 16 16"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle cx="8" cy="8" r="2.5" />
										<path d="M13.3 10.1a1.1 1.1 0 0 0 .2 1.2l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.67 1.01v.11a1.33 1.33 0 1 1-2.67 0v-.06A1.1 1.1 0 0 0 5.9 13.3a1.1 1.1 0 0 0-1.2.2l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1.01-.67h-.11a1.33 1.33 0 1 1 0-2.67h.06A1.1 1.1 0 0 0 2.7 5.9a1.1 1.1 0 0 0-.2-1.2l-.04-.04A1.33 1.33 0 1 1 4.34 2.78l.04.04a1.1 1.1 0 0 0 1.2.2h.05a1.1 1.1 0 0 0 .67-1.01v-.11a1.33 1.33 0 0 1 2.67 0v.06a1.1 1.1 0 0 0 .67 1.01 1.1 1.1 0 0 0 1.2-.2l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.2 1.2v.05a1.1 1.1 0 0 0 1.01.67h.11a1.33 1.33 0 0 1 0 2.67h-.06a1.1 1.1 0 0 0-1.01.67Z" />
									</svg>
								</Link>
							</div>
							<p className="text-[10px] text-text-faint mt-2">v0.1.0</p>
							<button
								type="button"
								onClick={handleLogout}
								className="flex items-center gap-1.5 text-text-faint hover:text-danger transition-colors mt-1.5"
								title={t('common.logout')}
							>
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
									<polyline points="16 17 21 12 16 7" />
									<line x1="21" y1="12" x2="9" y2="12" />
								</svg>
								<span className="text-[10px]">{t('common.logout')}</span>
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

function NavLink({ to, label, proBadge }: { to: string; label: string; proBadge?: boolean }) {
	return (
		<Link
			to={to}
			className="flex items-center px-3 py-2 rounded-md text-sm text-text-secondary transition-colors hover:bg-surface-alt hover:text-text"
			activeProps={{ className: 'bg-surface-alt text-text font-medium' }}
		>
			{label}
			{proBadge && <ProBadge />}
		</Link>
	)
}

function CollapsedNavLink({
	to,
	title,
	icon,
}: {
	to: string
	title: string
	icon: React.ReactNode
}) {
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
	const { t } = useTranslation()
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
			{collections.filter(isCollectionVisibleInSidebar).map((col) => {
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
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="shrink-0 opacity-50"
								>
									<line x1="8" y1="6" x2="21" y2="6" />
									<line x1="8" y1="12" x2="21" y2="12" />
									<line x1="8" y1="18" x2="21" y2="18" />
									<line x1="3" y1="6" x2="3.01" y2="6" />
									<line x1="3" y1="12" x2="3.01" y2="12" />
									<line x1="3" y1="18" x2="3.01" y2="18" />
								</svg>
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
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="12" y1="5" x2="12" y2="19" />
					<line x1="5" y1="12" x2="19" y2="12" />
				</svg>
				{t('nav.newCollection')}
			</Link>
		</div>
	)
}

function CollectionNavCollapsed() {
	const { t } = useTranslation()
	const { collections } = useCollections()

	return (
		<div className="space-y-0.5">
			{collections.filter(isCollectionVisibleInSidebar).map((col) => (
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
				title={t('nav.newCollection')}
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="12" y1="5" x2="12" y2="19" />
					<line x1="5" y1="12" x2="19" y2="12" />
				</svg>
			</Link>
		</div>
	)
}
