import { httpRequest } from '@innolope/sdk'

/**
 * Normalize an arbitrary label into the kebab-case slug the CMS accepts
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). Agents routinely pass human titles like
 * "Welsh Rarebit" or accented text; without this the API rejects them with a
 * slug-regex validation error (HTTP 400). Falls back to the original string if
 * normalization would leave it empty, so the caller still gets a clear
 * server-side error rather than a silently blank slug.
 */
export function slugify(slug: string): string {
	const normalized = slug
		.normalize('NFKD') // split accented chars into base + diacritic
		.replace(/[̀-ͯ]/g, '') // strip the diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics → single hyphen
		.replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
	return normalized || slug
}

/** First ATX heading (`# ...`) in the markdown, else the first non-empty line. */
function firstMarkdownHeading(markdown: string): string | undefined {
	for (const line of markdown.split('\n')) {
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
		if (heading) return heading[1].trim()
	}
	return markdown
		.split('\n')
		.map((l) => l.trim())
		.find(Boolean)
}

/**
 * Resolve the slug for a write. Prefer an explicit slug; otherwise derive one
 * from `metadata.title`, then the markdown's first heading — so agents can
 * create content without hand-authoring a URL slug. Always run through slugify
 * so the result satisfies the CMS's kebab-case rule.
 */
export function resolveSlug(input: {
	slug?: string
	metadata?: Record<string, unknown>
	markdown?: string
}): string {
	if (input.slug?.trim()) return slugify(input.slug)
	const title = typeof input.metadata?.title === 'string' ? input.metadata.title : undefined
	const source = title || (input.markdown ? firstMarkdownHeading(input.markdown) : undefined) || ''
	const derived = slugify(source)
	if (!derived) {
		throw new Error(
			'Cannot determine a slug: pass `slug`, or include a `metadata.title` or a markdown heading to derive one from.',
		)
	}
	return derived
}

export class InnolopeClient {
	private baseUrl: string
	private apiKey: string
	private projectId: string | undefined

	constructor(baseUrl: string, apiKey: string, projectId?: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '')
		this.apiKey = apiKey
		this.projectId = projectId
	}

	/** The base API URL this client targets (used to build a connection string). */
	get apiUrl(): string {
		return this.baseUrl
	}

	/**
	 * Select the active project for subsequent calls. A project-scoped `ink_` key
	 * ignores this (its own project wins server-side), but an account-scoped key or
	 * an OAuth-user session uses it to send `X-Project-Id`.
	 */
	setProject(projectId: string): void {
		this.projectId = projectId
	}

	getProjectId(): string | undefined {
		return this.projectId
	}

	private async request<T>(
		path: string,
		options?: RequestInit,
		projectIdOverride?: string,
	): Promise<T> {
		// API key is already project-scoped, but explicit header is a fallback and
		// the selection mechanism for account/OAuth callers. A per-call override lets
		// a tool target a project before `setProject` has run (e.g. right after create).
		return httpRequest<T>(this.baseUrl, path, {
			...options,
			apiKey: this.apiKey,
			projectId: projectIdOverride ?? this.projectId,
		})
	}

	// --- Project & provisioning ------------------------------------------------

	async listProjects() {
		return this.request<ProjectItem[]>('/api/v1/projects')
	}

	async createProject(input: { name: string; slug: string }) {
		return this.request<ProjectItem>('/api/v1/projects', {
			method: 'POST',
			body: JSON.stringify(input),
		})
	}

	async createCollection(
		input: {
			name: string
			label: string
			description?: string
			fields?: unknown[]
			titleField?: string | null
		},
		projectIdOverride?: string,
	) {
		return this.request<CollectionItem>(
			'/api/v1/collections',
			{ method: 'POST', body: JSON.stringify(input) },
			projectIdOverride,
		)
	}

	/** Mint a project-scoped `ink_` API key (the per-project connection string). */
	async createProjectApiKey(
		input: { name: string; permissions?: string[] },
		projectIdOverride?: string,
	) {
		return this.request<{
			id: string
			name: string
			key: string
			keyPrefix: string
			projectId: string
			permissions: string[]
			createdAt: string
			warning: string
		}>('/api/v1/auth/api-keys', { method: 'POST', body: JSON.stringify(input) }, projectIdOverride)
	}

	private requireProjectId(): string {
		const id = this.projectId
		if (!id)
			throw new Error('No active project selected. Call create_project or use_project first.')
		return id
	}

	// --- External database import ---------------------------------------------

	async testExternalDatabase(input: { type: string; connectionString: string; database?: string }) {
		const id = this.requireProjectId()
		return this.request<{ ok: boolean; message: string }>(`/api/v1/projects/${id}/database/test`, {
			method: 'POST',
			body: JSON.stringify(input),
		})
	}

	async scanExternalDatabase(input: { type: string; connectionString: string; database?: string }) {
		const id = this.requireProjectId()
		return this.request<{
			tables: Array<{
				name: string
				columns: Array<{ name: string; type: string }>
				count: number
				sizeBytes: number
			}>
		}>(`/api/v1/projects/${id}/database/scan`, { method: 'POST', body: JSON.stringify(input) })
	}

	async configureExternalDatabase(input: {
		type: string
		connectionString?: string
		database?: string
		tables?: Array<{ name: string; columns: Array<{ name: string; type: string }>; count?: number }>
		accessMode?: 'read-write' | 'read-only'
		visibleTables?: string[]
	}) {
		const id = this.requireProjectId()
		return this.request<Record<string, unknown>>(`/api/v1/projects/${id}/database`, {
			method: 'PUT',
			body: JSON.stringify(input),
		})
	}

	async getImportStatus() {
		const id = this.requireProjectId()
		return this.request<{
			summary: {
				total: number
				pending: number
				running: number
				completed: number
				failed: number
			}
			jobs: Array<{
				collectionId: string
				collectionName: string | null
				externalTable: string
				status: string
				total: number | null
				processed: number
				error: string | null
			}>
		}>(`/api/v1/projects/${id}/database/import-status`)
	}

	async listCollections() {
		return this.request<CollectionItem[]>('/api/v1/collections')
	}

	async getCollection(id: string) {
		return this.request<CollectionItem>(`/api/v1/collections/${id}`)
	}

	async bulkCreateContent(
		items: Array<{
			slug?: string
			collectionId: string
			markdown: string
			metadata?: Record<string, unknown>
			locale?: string
			status?: string
			createdAt?: string
			updatedAt?: string
			publishedAt?: string
		}>,
	) {
		const normalized = items.map((item) => ({ ...item, slug: resolveSlug(item) }))
		return this.request<{ data: ContentItem[]; count: number }>('/api/v1/content/bulk', {
			method: 'POST',
			body: JSON.stringify({ items: normalized }),
		})
	}

	async bulkUpdateContent(
		items: Array<{
			id: string
			slug?: string
			markdown?: string
			metadata?: Record<string, unknown>
			status?: string
		}>,
	) {
		const normalized = items.map((item) =>
			item.slug !== undefined ? { ...item, slug: slugify(item.slug) } : item,
		)
		return this.request<{ data: ContentItem[]; count: number }>('/api/v1/content/bulk', {
			method: 'PUT',
			body: JSON.stringify({ items: normalized }),
		})
	}

	async queryByFields(
		collectionId: string,
		filters: Record<string, unknown>,
		page?: number,
		limit?: number,
	) {
		return this.request<{ data: ContentItem[]; pagination: Pagination }>(
			'/api/v1/content/query-by-fields',
			{
				method: 'POST',
				body: JSON.stringify({ collectionId, filters, page, limit }),
			},
		)
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
		slug?: string
		collectionId: string
		markdown: string
		metadata?: Record<string, unknown>
		locale?: string
		status?: string
		createdAt?: string
		updatedAt?: string
		publishedAt?: string
	}) {
		return this.request<ContentItem>('/api/v1/content', {
			method: 'POST',
			body: JSON.stringify({ ...input, slug: resolveSlug(input) }),
		})
	}

	async updateContent(
		id: string,
		input: {
			slug?: string
			markdown?: string
			metadata?: Record<string, unknown>
			status?: string
		},
	) {
		return this.request<ContentItem>(`/api/v1/content/${id}`, {
			method: 'PUT',
			body: JSON.stringify(
				input.slug !== undefined ? { ...input, slug: slugify(input.slug) } : input,
			),
		})
	}

	async publishContent(id: string) {
		return this.updateContent(id, { status: 'published' })
	}

	async deleteContent(id: string) {
		return this.request<void>(`/api/v1/content/${id}`, { method: 'DELETE' })
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

	async semanticSearch(params: {
		query: string
		threshold?: number
		limit?: number
		collectionId?: string
		hybrid?: boolean
	}) {
		return this.request<{
			data: Array<{
				contentId: string
				slug: string
				title: string
				status: string
				similarity: number
				matchedChunk: string
			}>
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
		return httpRequest<string>(this.baseUrl, `/api/v1/content/export${qs ? `?${qs}` : ''}`, {
			apiKey: this.apiKey,
			projectId: this.projectId,
			raw: true,
		})
	}

	async trackAnalytics(data: {
		contentId?: string
		event: string
		query?: string
		source: string
	}) {
		return this.request<void>('/api/v1/stats/track', {
			method: 'POST',
			body: JSON.stringify(data),
		}).catch(() => {}) // fire-and-forget
	}

	/** Report MCP tool invocation to the API for PostHog tracking */
	trackToolCall(data: {
		tool: string
		durationMs: number
		success: boolean
		error?: string
		params?: Record<string, unknown>
	}) {
		this.request<void>('/api/v1/stats/mcp-usage', {
			method: 'POST',
			body: JSON.stringify(data),
		}).catch(() => {}) // fire-and-forget, never block MCP response
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

interface ProjectItem {
	id: string
	slug: string
	name: string
	role?: string
	ownerId?: string
	createdAt?: string
}

interface CollectionItem {
	id: string
	label: string
	name: string
	description: string | null
	fields: Array<{
		name: string
		type: string
		required?: boolean
		localized?: boolean
		options?: string[]
	}>
}

interface Pagination {
	page: number
	limit: number
	total: number
	totalPages?: number
}
