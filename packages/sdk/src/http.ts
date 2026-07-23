/**
 * Shared fetch wrapper for every Innolope API client (the public content SDK and
 * the internal MCP authoring client). Consolidating it here keeps auth header
 * handling, the 204 case, error shaping, and the error-message format identical
 * across clients instead of each hand-rolling its own copy that drifts.
 */
export interface HttpRequestOptions extends RequestInit {
	/** Bearer API key. Omitted for anonymous public-content reads. */
	apiKey?: string
	/** Optional X-Project-Id header (project-scoped keys already carry this). */
	projectId?: string
	/** Return the raw response text instead of parsing JSON (e.g. JSONL export). */
	raw?: boolean
}

/**
 * Thrown on a non-2xx response. Carries the HTTP `status` and the parsed error
 * `body` so callers can branch on them (e.g. surface a 403 license/upgrade
 * message) instead of string-matching `message`. `message` keeps the historical
 * `Innolope API <status>: <error>` format so existing catches still read.
 */
export class InnolopeApiError extends Error {
	readonly status: number
	readonly body: unknown
	constructor(status: number, body: unknown) {
		const detail =
			body && typeof body === 'object' && 'error' in body
				? String((body as { error: unknown }).error)
				: 'Request failed'
		super(`Innolope API ${status}: ${detail}`)
		this.name = 'InnolopeApiError'
		this.status = status
		this.body = body
	}
}

export async function httpRequest<T>(
	baseUrl: string,
	path: string,
	options: HttpRequestOptions = {},
): Promise<T> {
	const { apiKey, projectId, raw, headers: extraHeaders, ...init } = options

	// Only claim a JSON body when one is actually sent — Fastify rejects a
	// bodyless request that carries Content-Type: application/json (400
	// FST_ERR_CTP_EMPTY_JSON_BODY), which broke bodyless DELETEs.
	const headers: Record<string, string> = {}
	if (init.body != null) headers['Content-Type'] = 'application/json'
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	if (projectId) headers['X-Project-Id'] = projectId

	const response = await fetch(`${baseUrl}${path}`, {
		headers: { ...headers, ...(extraHeaders as Record<string, string> | undefined) },
		...init,
	})

	if (!response.ok) {
		const err = await response.json().catch(() => ({ error: response.statusText }))
		throw new InnolopeApiError(response.status, err)
	}

	if (response.status === 204) return undefined as T
	if (raw) return (await response.text()) as T
	return (await response.json()) as T
}
