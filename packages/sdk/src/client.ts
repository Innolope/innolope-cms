import { httpRequest } from './http.js'
import type {
	Collection,
	Content,
	ContentListParams,
	ContentListResponse,
	LocaleInfo,
	MediaItem,
} from './types.js'

interface InnolopeConfig {
	baseUrl: string
	apiKey?: string
	/**
	 * Locale added to every content request that does not name one. Leave it
	 * unset to read every locale — the API does not default to "en", and a
	 * project configured with other locales would otherwise return nothing.
	 */
	locale?: string
}

export class InnolopeCMS {
	private baseUrl: string
	private apiKey?: string
	private defaultLocale?: string

	constructor(config: InnolopeConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, '')
		this.apiKey = config.apiKey
		this.defaultLocale = config.locale
	}

	private async request<T>(path: string, options?: RequestInit): Promise<T> {
		return httpRequest<T>(this.baseUrl, path, { ...options, apiKey: this.apiKey })
	}

	// Content

	async getContent(params?: ContentListParams): Promise<ContentListResponse> {
		const query = new URLSearchParams()
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) query.set(key, String(value))
			}
		}
		if (!params?.locale && this.defaultLocale) query.set('locale', this.defaultLocale)
		const qs = query.toString()
		return this.request<ContentListResponse>(`/api/v1/content${qs ? `?${qs}` : ''}`)
	}

	async getContentById(id: string, params?: { depth?: number }): Promise<Content> {
		const qs = params?.depth !== undefined ? `?depth=${params.depth}` : ''
		return this.request<Content>(`/api/v1/content/${id}${qs}`)
	}

	async getContentBySlug(slug: string, locale?: string): Promise<Content | null> {
		// Exact slug filter — a full-text search could rank a longer slug that
		// merely contains this one above the record itself.
		const result = await this.getContent({ slug, locale: locale || this.defaultLocale, limit: 1 })
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
		const collection = collections.find((c) => c.name === collectionSlug)
		if (!collection) throw new Error(`Collection "${collectionSlug}" not found`)
		return this.getContent({ ...params, collectionId: collection.id })
	}

	// Collections

	// Excludes the internal media-backed collection — use getMedia() to fetch assets.
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

	async getTranslations(
		slug: string,
	): Promise<Record<string, { id: string; locale: string; status: string }>> {
		return this.request(`/api/v1/locales/translations/${slug}`)
	}

	// Health

	async health(): Promise<{ status: string; name: string; version: string }> {
		return this.request('/api/v1/health')
	}
}
