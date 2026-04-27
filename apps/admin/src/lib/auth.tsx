import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

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

	const apiRequest = useCallback(
		async (path: string, options?: RequestInit) => {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' }
			const projectId = localStorage.getItem('innolope_project')
			if (projectId) headers['X-Project-Id'] = projectId

			const method = options?.method?.toUpperCase() || 'GET'
			if (method !== 'GET' && method !== 'HEAD') {
				const csrfMatch = document.cookie.match(/(?:^|;\s*)innolope_csrf=([^;]+)/)
				if (csrfMatch) headers['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1])
			}

			let res = await fetch(path, { headers, credentials: 'include', ...options })

			// On 401, try refreshing the access token, then retry
			if (res.status === 401 && !path.includes('/auth/refresh')) {
				const refreshRes = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
				if (refreshRes.ok) {
					// Re-read CSRF token after refresh (cookie was updated)
					const retryHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
					if (projectId) retryHeaders['X-Project-Id'] = projectId
					if (method !== 'GET' && method !== 'HEAD') {
						const csrfMatch = document.cookie.match(/(?:^|;\s*)innolope_csrf=([^;]+)/)
						if (csrfMatch) retryHeaders['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1])
					}
					res = await fetch(path, { headers: retryHeaders, credentials: 'include', ...options })
				}
			}

			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: res.statusText }))
				throw new Error((err as { error: string }).error)
			}
			return res.json()
		},
		[],
	)

	const refreshUser = useCallback(async () => {
		if (!authenticated) return
		try {
			const u = (await apiRequest('/api/v1/auth/me')) as User
			setUser(u)
		} catch { /* ignore */ }
	}, [authenticated, apiRequest])

	const refreshProjects = useCallback(async () => {
		if (!authenticated) return
		try {
			const data = (await apiRequest('/api/v1/projects')) as Project[]
			setProjects(data)

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
		// Probe for an existing session; /me returns null (not 401) when logged out,
		// so we don't fan out to /projects until we know the user is authenticated.
		apiRequest('/api/v1/auth/me')
			.then(async (u) => {
				if (u) {
					setUser(u as User)
					await refreshProjects()
				} else {
					setAuthenticated(false)
					setUser(null)
				}
			})
			.catch(() => {
				setAuthenticated(false)
				setUser(null)
			})
			.finally(() => setLoading(false))
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
		} catch { /* best effort */ }
		localStorage.removeItem('innolope_project')
		setAuthenticated(false)
		setUser(null)
		setProjects([])
		setCurrentProject(null)
	}

	const switchProject = (projectId: string) => {
		const proj = projects.find((p) => p.id === projectId)
		if (proj) {
			setCurrentProject(proj)
			localStorage.setItem('innolope_project', projectId)
			window.location.reload() // Reload to refresh all data
		}
	}

	return (
		<AuthContext.Provider
			value={{ user, loading, projects, currentProject, login, register, logout, switchProject, refreshProjects, refreshUser }}
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
