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
	/** Exact slug match. */
	slug?: string
	status?: 'draft' | 'published' | 'archived'
	locale?: string
	search?: string
	page?: number
	limit?: number
	sortBy?: 'createdAt' | 'updatedAt' | 'publishedAt'
	sortOrder?: 'asc' | 'desc'
	/**
	 * Relation hydration depth. `0` returns relation fields as raw ids; `>=1` (the API
	 * default) resolves them to the referenced record. A `relation` field such as an
	 * article's `featuredImage` is therefore an object (`{ id, url, alt, … }`) at
	 * depth >= 1, not a bare string.
	 */
	depth?: number
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
	label: string
	name: string
	description: string | null
	fields: { name: string; type: string; required?: boolean; localized?: boolean }[]
	/** `publicUrlTemplate`: where a record lives on the site, e.g. `https://example.com/blog/{slug}/`. */
	settings?: { publicUrlTemplate?: string }
}

/**
 * The IndexNow key-file contract (GET /api/v1/indexnow/key). Write
 * `keyFile.content` to `keyFile.path` on the site so search engines can verify
 * the CMS's submissions. All fields are null when no key is configured.
 */
export interface IndexNowKeyFile {
	enabled: boolean
	key: string | null
	/** The configured key-file URL, or null for the default `https://<host>/<key>.txt`. */
	keyLocation: string | null
	keyFile: { path: string; content: string } | null
	/** Each host the project submits for, with the key-file URL used there. */
	hosts: { host: string; keyLocation: string }[]
}

export interface LocaleInfo {
	configured: string[]
	defaultLocale: string
	available: string[]
}
