const API_BASE = import.meta.env.VITE_API_URL || ''

const LOGIN_PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password', '/accept-invite']

/** One Zod / Fastify-validation issue surfaced from the API. */
export interface ApiErrorIssue {
	/** Dotted path to the offending field, e.g. `slug` or `metadata.title`. */
	path: string
	/** Human-readable validation message. */
	message: string
}

/** Shape of the JSON body returned by the API for any non-2xx response. */
export interface ApiErrorPayload {
	error?: string
	statusCode?: number
	issues?: ApiErrorIssue[]
}

/**
 * Thrown by `api.*` helpers on non-2xx responses. Callers can inspect `status`
 * and `issues` to surface field-level errors next to inputs instead of showing
 * a generic toast.
 */
export class ApiError extends Error {
	readonly status: number
	readonly issues: ApiErrorIssue[]

	constructor(status: number, payload: ApiErrorPayload) {
		const issues = Array.isArray(payload.issues) ? payload.issues : []
		const baseMsg = payload.error || (status >= 500 ? 'Server error' : 'Request failed')
		// Surface the first field issue in the message so a caller that only
		// reads `error.message` (e.g. a generic toast) still gets useful info.
		const message = issues.length
			? `${baseMsg}: ${issues[0].path ? `${issues[0].path}: ` : ''}${issues[0].message}`
			: baseMsg
		super(message)
		this.name = 'ApiError'
		this.status = status
		this.issues = issues
	}
}

/**
 * Returns `/login?next=<encoded current path>` for the current location, unless the
 * user is already on a public/login-adjacent page (in which case `next` is omitted to
 * avoid redirect loops or accidentally bouncing back to `/login` after sign-in).
 *
 * Exported so callers (auth gate, login page) can reuse the same shape.
 */
export function loginUrlPreservingNext(): string {
	const path = `${window.location.pathname}${window.location.search}${window.location.hash}`
	if (LOGIN_PUBLIC_PATHS.some((p) => window.location.pathname.startsWith(p))) {
		return '/login'
	}
	if (!path || path === '/') return '/login'
	return `/login?next=${encodeURIComponent(path)}`
}

function getProjectId(): string | null {
	return localStorage.getItem('innolope_project')
}

/** Read the double-submit CSRF token from the `innolope_csrf` cookie. */
export function getCsrfToken(): string | null {
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
		.finally(() => {
			refreshPromise = null
		})
	return refreshPromise
}

function buildHeaders(options?: RequestInit): Record<string, string> {
	const headers: Record<string, string> = {
		...(options?.headers as Record<string, string>),
	}
	const projectId = getProjectId()
	if (projectId) headers['X-Project-Id'] = projectId

	const method = options?.method?.toUpperCase() || 'GET'
	if (method !== 'GET' && method !== 'HEAD') {
		const csrf = getCsrfToken()
		if (csrf) headers['X-CSRF-Token'] = csrf
	}

	if (options?.body !== undefined && !(options.body instanceof FormData)) {
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
			window.location.href = loginUrlPreservingNext()
			throw new Error('Session expired')
		}
	}

	if (!response.ok) {
		const payload = await response.json().catch(() => ({ error: response.statusText }))
		throw new ApiError(response.status, payload as ApiErrorPayload)
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
	patch: <T>(path: string, body: unknown) =>
		request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
	delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
	upload: <T>(path: string, formData: FormData) =>
		request<T>(path, { method: 'POST', body: formData }),
}
