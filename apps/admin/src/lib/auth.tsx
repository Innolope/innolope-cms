import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { getCsrfToken } from './api-client'

interface User {
	id: string
	email: string
	name: string
	role: string
}

interface Project {
	id: string
	name: string
	slug: string
	role: string
	settings: Record<string, unknown>
}

interface AuthState {
	user: User | null
	loading: boolean
	projects: Project[]
	currentProject: Project | null
	/** True when the CMS is reached via a project's custom domain. */
	domainLocked: boolean
	/** Name of the project bound to the custom domain, if any. */
	domainProjectName: string | null
	login: (email: string, password: string) => Promise<void>
	register: (email: string, password: string, name: string) => Promise<void>
	logout: () => void
	switchProject: (projectId: string) => void
	refreshProjects: () => Promise<void>
	refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null)
	const [authenticated, setAuthenticated] = useState(true) // Assume authenticated, /me will confirm
	const [loading, setLoading] = useState(true)
	const [projects, setProjects] = useState<Project[]>([])
	const [currentProject, setCurrentProject] = useState<Project | null>(null)
	const [domainProject, setDomainProject] = useState<{
		id: string
		name: string
		slug: string
	} | null>(null)
	// Holds the custom-domain project id synchronously so refreshProjects can lock to it.
	const domainProjectIdRef = useRef<string | null>(null)

	const apiRequest = useCallback(async (path: string, options?: RequestInit) => {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' }
		const projectId = localStorage.getItem('innolope_project')
		if (projectId) headers['X-Project-Id'] = projectId

		const method = options?.method?.toUpperCase() || 'GET'
		if (method !== 'GET' && method !== 'HEAD') {
			const csrf = getCsrfToken()
			if (csrf) headers['X-CSRF-Token'] = csrf
		}

		let res = await fetch(path, { headers, credentials: 'include', ...options })

		// On 401, try refreshing the access token, then retry
		if (res.status === 401 && !path.includes('/auth/refresh')) {
			const refreshRes = await fetch('/api/v1/auth/refresh', {
				method: 'POST',
				credentials: 'include',
			})
			if (refreshRes.ok) {
				// Re-read CSRF token after refresh (cookie was updated)
				const retryHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
				if (projectId) retryHeaders['X-Project-Id'] = projectId
				if (method !== 'GET' && method !== 'HEAD') {
					const csrf = getCsrfToken()
					if (csrf) retryHeaders['X-CSRF-Token'] = csrf
				}
				res = await fetch(path, { headers: retryHeaders, credentials: 'include', ...options })
			}
		}

		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: res.statusText }))
			throw new Error((err as { error: string }).error)
		}
		return res.json()
	}, [])

	const refreshUser = useCallback(async () => {
		if (!authenticated) return
		try {
			const u = (await apiRequest('/api/v1/auth/me')) as User
			setUser(u)
		} catch {
			/* ignore */
		}
	}, [authenticated, apiRequest])

	const refreshProjects = useCallback(async () => {
		if (!authenticated) return
		try {
			const data = (await apiRequest('/api/v1/projects')) as Project[]
			setProjects(data)

			// On a custom domain, the project is fixed — never auto-select another.
			if (domainProjectIdRef.current) {
				setCurrentProject(data.find((p) => p.id === domainProjectIdRef.current) ?? null)
				return
			}

			const savedProjectId = localStorage.getItem('innolope_project')
			const saved = data.find((p) => p.id === savedProjectId)

			if (saved) {
				setCurrentProject(saved)
			} else if (data.length > 0) {
				setCurrentProject(data[0])
				localStorage.setItem('innolope_project', data[0].id)
			} else {
				setCurrentProject(null)
				localStorage.removeItem('innolope_project')
			}
		} catch {
			setProjects([])
		}
	}, [authenticated, apiRequest])

	useEffect(() => {
		;(async () => {
			// Resolve the custom-domain project first so refreshProjects can lock to it.
			try {
				const res = await fetch('/api/v1/auth/domain-context')
				if (res.ok) {
					const d = (await res.json()) as {
						projectId: string
						projectName: string
						projectSlug: string
					}
					domainProjectIdRef.current = d.projectId
					localStorage.setItem('innolope_project', d.projectId)
					setDomainProject({ id: d.projectId, name: d.projectName, slug: d.projectSlug })
				}
			} catch {
				/* not a custom domain */
			}

			// Check if we have a valid session by calling /me
			try {
				await Promise.all([
					apiRequest('/api/v1/auth/me').then((u) => setUser(u as User)),
					refreshProjects(),
				])
			} catch {
				setAuthenticated(false)
				setUser(null)
			} finally {
				setLoading(false)
			}
		})()
	}, [apiRequest, refreshProjects])

	const login = async (email: string, password: string) => {
		const res = (await apiRequest('/api/v1/auth/login', {
			method: 'POST',
			body: JSON.stringify({ email, password }),
		})) as { user: User }
		setAuthenticated(true)
		setUser(res.user)
	}

	const register = async (email: string, password: string, name: string) => {
		const res = (await apiRequest('/api/v1/auth/register', {
			method: 'POST',
			body: JSON.stringify({ email, password, name }),
		})) as { user: User }
		setAuthenticated(true)
		setUser(res.user)
	}

	const logout = async () => {
		try {
			await apiRequest('/api/v1/auth/logout', { method: 'POST' })
		} catch {
			/* best effort */
		}
		// On a custom domain keep the project pinned; elsewhere clear the selection.
		if (!domainProjectIdRef.current) localStorage.removeItem('innolope_project')
		setAuthenticated(false)
		setUser(null)
		setProjects([])
		setCurrentProject(null)
	}

	const switchProject = (projectId: string) => {
		// The project is fixed when reached via a custom domain.
		if (domainProjectIdRef.current) return
		const proj = projects.find((p) => p.id === projectId)
		if (proj) {
			setCurrentProject(proj)
			localStorage.setItem('innolope_project', projectId)
			window.location.reload() // Reload to refresh all data
		}
	}

	return (
		<AuthContext.Provider
			value={{
				user,
				loading,
				projects,
				currentProject,
				domainLocked: domainProject != null,
				domainProjectName: domainProject?.name ?? null,
				login,
				register,
				logout,
				switchProject,
				refreshProjects,
				refreshUser,
			}}
		>
			{children}
		</AuthContext.Provider>
	)
}

export function useAuth() {
	const ctx = useContext(AuthContext)
	if (!ctx) throw new Error('useAuth must be used within AuthProvider')
	return ctx
}
