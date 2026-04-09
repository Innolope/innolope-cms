export type ContentStatus = 'draft' | 'published' | 'archived'

export interface Content {
	id: string
	slug: string
	status: ContentStatus
	collectionId: string
	metadata: Record<string, unknown>
	markdown: string
	html: string
	locale: string
	createdAt: string
	updatedAt: string
	publishedAt: string | null
	createdBy: string
	version: number
}

export interface ContentInput {
	slug: string
	collectionId: string
	metadata?: Record<string, unknown>
	markdown: string
	locale?: string
	status?: ContentStatus
}

export interface ContentListParams {
	collectionId?: string
	status?: ContentStatus
	locale?: string
	tag?: string
	search?: string
	page?: number
	limit?: number
	sortBy?: 'createdAt' | 'updatedAt' | 'publishedAt'
	sortOrder?: 'asc' | 'desc'
}
