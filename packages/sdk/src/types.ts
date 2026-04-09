export interface Content {
	id: string
	slug: string
	status: 'draft' | 'published' | 'archived'
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

export interface ContentListParams {
	collectionId?: string
	status?: 'draft' | 'published' | 'archived'
	locale?: string
	search?: string
	page?: number
	limit?: number
	sortBy?: 'createdAt' | 'updatedAt' | 'publishedAt'
	sortOrder?: 'asc' | 'desc'
}

export interface ContentListResponse {
	data: Content[]
	pagination: {
		page: number
		limit: number
		total: number
		totalPages: number
	}
}

export interface MediaItem {
	id: string
	type: 'image' | 'video' | 'file'
	filename: string
	mimeType: string
	size: number
	url: string
	alt: string | null
	createdAt: string
}

export interface Collection {
	id: string
	name: string
	slug: string
	description: string | null
	fields: { name: string; type: string; required?: boolean; localized?: boolean }[]
}

export interface LocaleInfo {
	configured: string[]
	defaultLocale: string
	available: string[]
}
