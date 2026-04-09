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
	token: string | null
	loading: boolean
	projects: Project[]
	currentProject: Project | null
	login: (email: string, password: string) => Promise<void>
	register: (email: string, password: string, name: string) => Promise<void>
	logout: () => void
	switchProject: (projectId: string) => void
	refreshProjects: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null)
	const [token, setToken] = useState<string | null>(() => localStorage.getItem('innolope_token'))
	const [loading, setLoading] = useState(true)
	const [projects, setProjects] = useState<Project[]>([])
	const [currentProject, setCurrentProject] = useState<Project | null>(null)

	const apiRequest = useCallback(
		async (path: string, options?: RequestInit) => {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' }
			if (token) headers.Authorization = `Bearer ${token}`
			const projectId = localStorage.getItem('innolope_project')
			if (projectId) headers['X-Project-Id'] = projectId

			const res = await fetch(path, { headers, ...options })
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: res.statusText }))
				throw new Error((err as { error: string }).error)
			}
			return res.json()
		},
		[token],
	)

	const refreshProjects = useCallback(async () => {
		if (!token) return
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
	}, [token, apiRequest])

	useEffect(() => {
		if (!token) {
			setLoading(false)
			return
		}
		Promise.all([
			apiRequest('/api/v1/auth/me').then((u) => setUser(u as User)),
			refreshProjects(),
		])
			.catch(() => {
				localStorage.removeItem('innolope_token')
				setToken(null)
			})
			.finally(() => setLoading(false))
	}, [token, apiRequest, refreshProjects])

	const login = async (email: string, password: string) => {
		const res = (await apiRequest('/api/v1/auth/login', {
			method: 'POST',
			body: JSON.stringify({ email, password }),
		})) as { user: User; token: string }
		localStorage.setItem('innolope_token', res.token)
		setToken(res.token)
		setUser(res.user)
	}

	const register = async (email: string, password: string, name: string) => {
		const res = (await apiRequest('/api/v1/auth/register', {
			method: 'POST',
			body: JSON.stringify({ email, password, name }),
		})) as { user: User; token: string }
		localStorage.setItem('innolope_token', res.token)
		setToken(res.token)
		setUser(res.user)
	}

	const logout = () => {
		localStorage.removeItem('innolope_token')
		localStorage.removeItem('innolope_project')
		setToken(null)
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
			value={{ user, token, loading, projects, currentProject, login, register, logout, switchProject, refreshProjects }}
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
