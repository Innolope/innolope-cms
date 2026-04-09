export class InnolopeClient {
	private baseUrl: string
	private apiKey: string
	private projectId: string | undefined

	constructor(baseUrl: string, apiKey: string, projectId?: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '')
		this.apiKey = apiKey
		this.projectId = projectId
	}

	private async request<T>(path: string, options?: RequestInit): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.apiKey}`,
		}
		// API key is already project-scoped, but explicit header is a fallback
		if (this.projectId) {
			headers['X-Project-Id'] = this.projectId
		}

		const response = await fetch(`${this.baseUrl}${path}`, {
			headers: { ...headers, ...options?.headers },
			...options,
		})

		if (!response.ok) {
			const err = await response.json().catch(() => ({ error: response.statusText }))
			throw new Error(`API error ${response.status}: ${(err as { error: string }).error}`)
		}

		if (response.status === 204) return undefined as T
		return response.json() as Promise<T>
	}

	async listCollections() {
		return this.request<{ data: unknown[] }>('/api/v1/collections')
	}

	async listContent(params?: {
		collectionId?: string
		status?: string
		locale?: string
		search?: string
		page?: number
		limit?: number
	}) {
		const query = new URLSearchParams()
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) query.set(key, String(value))
			}
		}
		const qs = query.toString()
		return this.request<{ data: ContentItem[]; pagination: Pagination }>(
			`/api/v1/content${qs ? `?${qs}` : ''}`,
		)
	}

	async getContent(id: string) {
		return this.request<ContentItem>(`/api/v1/content/${id}`)
	}

	async createContent(input: {
		slug: string
		collectionId: string
		markdown: string
		metadata?: Record<string, unknown>
		locale?: string
		status?: string
	}) {
		return this.request<ContentItem>('/api/v1/content', {
			method: 'POST',
			body: JSON.stringify(input),
		})
	}

	async updateContent(
		id: string,
		input: { slug?: string; markdown?: string; metadata?: Record<string, unknown>; status?: string },
	) {
		return this.request<ContentItem>(`/api/v1/content/${id}`, {
			method: 'PUT',
			body: JSON.stringify(input),
		})
	}

	async publishContent(id: string) {
		return this.updateContent(id, { status: 'published' })
	}

	async searchContent(query: string) {
		return this.listContent({ search: query })
	}
}

interface ContentItem {
	id: string
	slug: string
	status: string
	collectionId: string
	metadata: Record<string, unknown>
	markdown: string
	html: string
	locale: string
	version: number
	createdAt: string
	updatedAt: string
	publishedAt: string | null
}

interface Pagination {
	page: number
	limit: number
	total: number
	totalPages?: number
}
