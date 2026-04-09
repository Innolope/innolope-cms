import { z } from 'zod'

export const contentInputSchema = z.object({
	slug: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	collectionId: z.string().uuid(),
	metadata: z.record(z.unknown()).optional(),
	markdown: z.string(),
	locale: z.string().min(2).max(10).optional(),
	status: z.enum(['draft', 'published', 'archived']).optional(),
})

export const contentListSchema = z.object({
	collectionId: z.string().uuid().optional(),
	status: z.enum(['draft', 'published', 'archived']).optional(),
	locale: z.string().optional(),
	search: z.string().optional(),
	page: z.coerce.number().int().positive().default(1),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	sortBy: z.enum(['createdAt', 'updatedAt', 'publishedAt']).default('createdAt'),
	sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

export const envSchema = z.object({
	DATABASE_URL: z.string().min(1),
	AUTH_SECRET: z.string().min(16),
	API_PORT: z.coerce.number().default(3001),
	API_HOST: z.string().default('0.0.0.0'),
	CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
	CLOUDFLARE_API_TOKEN: z.string().optional(),
	CLOUDFLARE_IMAGES_ACCOUNT_HASH: z.string().optional(),
	CLOUDFLARE_R2_BUCKET: z.string().optional(),
	CLOUDFLARE_R2_ACCESS_KEY_ID: z.string().optional(),
	CLOUDFLARE_R2_SECRET_ACCESS_KEY: z.string().optional(),
	CLOUDFLARE_R2_ENDPOINT: z.string().optional(),
})
