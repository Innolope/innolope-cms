const API_BASE = import.meta.env.VITE_API_URL || ''

function getToken(): string | null {
	return localStorage.getItem('innolope_token')
}

function getProjectId(): string | null {
	return localStorage.getItem('innolope_project')
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const token = getToken()
	const projectId = getProjectId()
	const headers: Record<string, string> = {
		...options?.headers as Record<string, string>,
	}

	if (token) headers.Authorization = `Bearer ${token}`
	if (projectId) headers['X-Project-Id'] = projectId

	if (!(options?.body instanceof FormData)) {
		headers['Content-Type'] = 'application/json'
	}

	const response = await fetch(`${API_BASE}${path}`, { ...options, headers })

	if (response.status === 401) {
		localStorage.removeItem('innolope_token')
		window.location.href = '/login'
		throw new Error('Session expired')
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: response.statusText }))
		throw new Error((error as { error: string }).error || 'Request failed')
	}

	if (response.status === 204) return undefined as T
	return response.json() as Promise<T>
}

export const api = {
	get: <T>(path: string) => request<T>(path),
	post: <T>(path: string, body: unknown) =>
		request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
	put: <T>(path: string, body: unknown) =>
		request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
	delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
	upload: <T>(path: string, formData: FormData) =>
		request<T>(path, { method: 'POST', body: formData }),
}
