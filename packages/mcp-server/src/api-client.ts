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
		return this.request<CollectionItem[]>('/api/v1/collections')
	}

	async getCollection(id: string) {
		return this.request<CollectionItem>(`/api/v1/collections/${id}`)
	}

	async bulkCreateContent(items: Array<{ slug: string; collectionId: string; markdown: string; metadata?: Record<string, unknown>; locale?: string; status?: string }>) {
		return this.request<{ data: ContentItem[]; count: number }>('/api/v1/content/bulk', {
			method: 'POST',
			body: JSON.stringify({ items }),
		})
	}

	async bulkUpdateContent(items: Array<{ id: string; slug?: string; markdown?: string; metadata?: Record<string, unknown>; status?: string }>) {
		return this.request<{ data: ContentItem[]; count: number }>('/api/v1/content/bulk', {
			method: 'PUT',
			body: JSON.stringify({ items }),
		})
	}

	async queryByFields(collectionId: string, filters: Record<string, unknown>, page?: number, limit?: number) {
		return this.request<{ data: ContentItem[]; pagination: Pagination }>('/api/v1/content/query-by-fields', {
			method: 'POST',
			body: JSON.stringify({ collectionId, filters, page, limit }),
		})
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

	async submitForReview(id: string) {
		return this.request<ContentItem>(`/api/v1/content/${id}/submit-for-review`, {
			method: 'POST',
			body: JSON.stringify({}),
		})
	}

	async semanticSearch(params: { query: string; threshold?: number; limit?: number; collectionId?: string; hybrid?: boolean }) {
		return this.request<{
			data: Array<{ contentId: string; slug: string; title: string; status: string; similarity: number; matchedChunk: string }>
			query: string
		}>('/api/v1/content/semantic-search', {
			method: 'POST',
			body: JSON.stringify(params),
		})
	}

	async exportContent(params?: { collectionId?: string; status?: string; format?: string }) {
		const query = new URLSearchParams()
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) query.set(key, String(value))
			}
		}
		const qs = query.toString()
		// Return raw text (JSONL)
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
		}
		if (this.projectId) headers['X-Project-Id'] = this.projectId

		const response = await fetch(`${this.baseUrl}/api/v1/content/export${qs ? `?${qs}` : ''}`, { headers })
		if (!response.ok) {
			const err = await response.json().catch(() => ({ error: response.statusText }))
			throw new Error(`API error ${response.status}: ${(err as { error: string }).error}`)
		}
		return response.text()
	}

	async trackAnalytics(data: { contentId?: string; event: string; query?: string; source: string }) {
		return this.request<void>('/api/v1/stats/track', {
			method: 'POST',
			body: JSON.stringify(data),
		}).catch(() => {}) // fire-and-forget
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

interface CollectionItem {
	id: string
	name: string
	slug: string
	description: string | null
	fields: Array<{ name: string; type: string; required?: boolean; localized?: boolean; options?: string[] }>
}

interface Pagination {
	page: number
	limit: number
	total: number
	totalPages?: number
}
