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

export async function httpRequest<T>(
	baseUrl: string,
	path: string,
	options: HttpRequestOptions = {},
): Promise<T> {
	const { apiKey, projectId, raw, headers: extraHeaders, ...init } = options

	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	if (projectId) headers['X-Project-Id'] = projectId

	const response = await fetch(`${baseUrl}${path}`, {
		headers: { ...headers, ...(extraHeaders as Record<string, string> | undefined) },
		...init,
	})

	if (!response.ok) {
		const err = await response.json().catch(() => ({ error: response.statusText }))
		throw new Error(`Innolope API ${response.status}: ${(err as { error: string }).error}`)
	}

	if (response.status === 204) return undefined as T
	if (raw) return (await response.text()) as T
	return (await response.json()) as T
}
