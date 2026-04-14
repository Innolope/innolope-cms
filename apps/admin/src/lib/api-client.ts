const API_BASE = import.meta.env.VITE_API_URL || ''

function getProjectId(): string | null {
	return localStorage.getItem('innolope_project')
}

function getCsrfToken(): string | null {
	const match = document.cookie.match(/(?:^|;\s*)innolope_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : null
}

// Serialize concurrent refresh attempts into a single request
let refreshPromise: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
	if (refreshPromise) return refreshPromise
	refreshPromise = fetch(`${API_BASE}/api/v1/auth/refresh`, {
		method: 'POST',
		credentials: 'include',
	})
		.then((res) => res.ok)
		.finally(() => { refreshPromise = null })
	return refreshPromise
}

function buildHeaders(options?: RequestInit): Record<string, string> {
	const headers: Record<string, string> = {
		...options?.headers as Record<string, string>,
	}
	const projectId = getProjectId()
	if (projectId) headers['X-Project-Id'] = projectId

	const method = options?.method?.toUpperCase() || 'GET'
	if (method !== 'GET' && method !== 'HEAD') {
		const csrf = getCsrfToken()
		if (csrf) headers['X-CSRF-Token'] = csrf
	}

	if (!(options?.body instanceof FormData)) {
		headers['Content-Type'] = 'application/json'
	}
	return headers
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
	const headers = buildHeaders(options)

	let response = await fetch(`${API_BASE}${path}`, {
		...options,
		headers,
		credentials: 'include',
	})

	// On 401, try refreshing the access token once, then retry
	if (response.status === 401 && !path.includes('/auth/refresh')) {
		const refreshed = await tryRefresh()
		if (refreshed) {
			// Retry with fresh CSRF token (cookie was just updated)
			const retryHeaders = buildHeaders(options)
			response = await fetch(`${API_BASE}${path}`, {
				...options,
				headers: retryHeaders,
				credentials: 'include',
			})
		}

		if (!refreshed || response.status === 401) {
			window.location.href = '/login'
			throw new Error('Session expired')
		}
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
