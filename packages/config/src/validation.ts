import { z } from 'zod'

/**
 * Single source of truth for content statuses. Every schema and MCP tool derives
 * its enum from this list (or a named slice of it) so the accepted values can't
 * drift between endpoints.
 */
export const CONTENT_STATUSES = ['draft', 'pending_review', 'published', 'archived'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

/**
 * Statuses a caller may set directly on create. `pending_review` is entered via
 * the submit-for-review workflow, and `archived` via update — not at creation.
 */
export const CREATABLE_CONTENT_STATUSES = ['draft', 'published'] as const

export const contentInputSchema = z.object({
	// Slug is optional — when null/missing, the record has no permalink (used by
	// imported collections where the source had no slug-like field). When
	// provided, it must be URL-shaped and within the standard bounds. Both "-"
	// and "_" are accepted separators: imported datasets routinely use
	// snake_case slugs, and rejecting them forced the slugifier to silently
	// rewrite caller-provided slugs into kebab-case.
	slug: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/)
		.nullable()
		.optional(),
	collectionId: z.string().uuid(),
	metadata: z.record(z.unknown()).optional(),
	markdown: z.string(),
	locale: z.string().min(2).max(10).optional(),
	status: z.enum(CONTENT_STATUSES).optional(),
	// Optional source timestamps — set by importers preserving original article history.
	// Accepted on create only; ignored on update (would clobber edit history).
	createdAt: z.string().datetime().optional(),
	updatedAt: z.string().datetime().optional(),
	publishedAt: z.string().datetime().optional(),
})

export const contentListSchema = z.object({
	collectionId: z.string().uuid().optional(),
	status: z.enum(CONTENT_STATUSES).optional(),
	locale: z.string().optional(),
	search: z.string().optional(),
	page: z.coerce.number().int().positive().default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	// Real columns (createdAt|updatedAt|publishedAt|slug|status|locale) or a metadata
	// field reference (`meta:<identifier>`). The regex keeps injection out at the boundary —
	// only an identifier can follow `meta:`. Bad values fall back to createdAt instead of 400ing.
	sortBy: z
		.string()
		.regex(/^(createdAt|updatedAt|publishedAt|slug|status|locale|meta:[a-zA-Z_][a-zA-Z0-9_]*)$/)
		.catch('createdAt'),
	sortOrder: z.enum(['asc', 'desc']).catch('desc'),
	updatedFrom: z.string().optional(),
	updatedTo: z.string().optional(),
	createdFrom: z.string().optional(),
	createdTo: z.string().optional(),
	publishedFrom: z.string().optional(),
	publishedTo: z.string().optional(),
	// JSON-encoded object of metadata field equality filters: {"author":"x","category":"y"}
	metadata: z.string().optional(),
	// Relation hydration depth: 0 = raw ids, >=1 = relation fields resolved to records.
	depth: z.coerce.number().int().min(0).max(2).default(1),
})

export const envSchema = z.object({
	DATABASE_URL: z.string().min(1),
	AUTH_SECRET: z.string().min(16),
	API_PORT: z.coerce.number().default(3001),
	API_HOST: z.string().default('0.0.0.0'),
	// Allowed CORS origin for the admin UI. Must be a concrete origin — never a wildcard.
	ADMIN_URL: z.string().url().optional(),
	CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
	CLOUDFLARE_API_TOKEN: z.string().optional(),
	CLOUDFLARE_IMAGES_ACCOUNT_HASH: z.string().optional(),
	CLOUDFLARE_R2_BUCKET: z.string().optional(),
	CLOUDFLARE_R2_ACCESS_KEY_ID: z.string().optional(),
	CLOUDFLARE_R2_SECRET_ACCESS_KEY: z.string().optional(),
	CLOUDFLARE_R2_ENDPOINT: z.string().optional(),
})
