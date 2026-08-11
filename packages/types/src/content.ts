/**
 * Kept in step with `CONTENT_STATUSES` in `@innolope/config`, which the API
 * validates against. This list was short by `pending_review` and `scheduled` for
 * a while, so the SDK's types rejected statuses the API happily returned.
 */
export type ContentStatus = 'draft' | 'pending_review' | 'scheduled' | 'published' | 'archived'

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
