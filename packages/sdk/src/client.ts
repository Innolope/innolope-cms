import type {
	Content,
	ContentListParams,
	ContentListResponse,
	MediaItem,
	Collection,
	LocaleInfo,
} from './types.js'

interface InnolopeConfig {
	baseUrl: string
	apiKey?: string
	locale?: string
}

export class InnolopeCMS {
	private baseUrl: string
	private apiKey?: string
	private defaultLocale: string

	constructor(config: InnolopeConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, '')
		this.apiKey = config.apiKey
		this.defaultLocale = config.locale || 'en'
	}

	private async request<T>(path: string, options?: RequestInit): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		}
		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`
		}

		const response = await fetch(`${this.baseUrl}${path}`, {
			headers: { ...headers, ...options?.headers },
			...options,
		})

		if (!response.ok) {
			const err = await response.json().catch(() => ({ error: response.statusText }))
			throw new Error(`Innolope API ${response.status}: ${(err as { error: string }).error}`)
		}

		if (response.status === 204) return undefined as T
		return response.json() as Promise<T>
	}

	// Content

	async getContent(params?: ContentListParams): Promise<ContentListResponse> {
		const query = new URLSearchParams()
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) query.set(key, String(value))
			}
		}
		if (!params?.locale) query.set('locale', this.defaultLocale)
		const qs = query.toString()
		return this.request<ContentListResponse>(`/api/v1/content${qs ? `?${qs}` : ''}`)
	}

	async getContentById(id: string): Promise<Content> {
		return this.request<Content>(`/api/v1/content/${id}`)
	}

	async getContentBySlug(slug: string, locale?: string): Promise<Content | null> {
		const result = await this.getContent({
			search: slug,
			locale: locale || this.defaultLocale,
			limit: 1,
		})
		return result.data.find((item) => item.slug === slug) || null
	}

	async getPublished(params?: Omit<ContentListParams, 'status'>): Promise<ContentListResponse> {
		return this.getContent({ ...params, status: 'published' })
	}

	async getByCollection(
		collectionSlug: string,
		params?: Omit<ContentListParams, 'collectionId'>,
	): Promise<ContentListResponse> {
		const collections = await this.getCollections()
		const collection = collections.find((c) => c.slug === collectionSlug)
		if (!collection) throw new Error(`Collection "${collectionSlug}" not found`)
		return this.getContent({ ...params, collectionId: collection.id })
	}

	// Collections

	async getCollections(): Promise<Collection[]> {
		return this.request<Collection[]>('/api/v1/collections')
	}

	async getCollection(id: string): Promise<Collection> {
		return this.request<Collection>(`/api/v1/collections/${id}`)
	}

	// Media

	async getMedia(params?: { type?: string; page?: number; limit?: number }): Promise<{
		data: MediaItem[]
		pagination: { page: number; limit: number; total: number }
	}> {
		const query = new URLSearchParams()
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) query.set(key, String(value))
			}
		}
		const qs = query.toString()
		return this.request(`/api/v1/media${qs ? `?${qs}` : ''}`)
	}

	// Locales

	async getLocales(): Promise<LocaleInfo> {
		return this.request<LocaleInfo>('/api/v1/locales')
	}

	async getTranslations(slug: string): Promise<Record<string, { id: string; locale: string; status: string }>> {
		return this.request(`/api/v1/locales/translations/${slug}`)
	}

	// Health

	async health(): Promise<{ status: string; name: string; version: string }> {
		return this.request('/api/v1/health')
	}
}
