import { createDb, type Database } from '@innolope/db'
import fp from 'fastify-plugin'
import postgres from 'postgres'

declare module 'fastify' {
	interface FastifyInstance {
		db: Database
	}
}

async function ensureTables(connectionUrl: string) {
	const sql = postgres(connectionUrl, {
		ssl: connectionUrl.includes('sslmode=verify-full') || connectionUrl.includes('sslmode=require')
			? 'require'
			: false,
	})

	// Drop old snake_case tables if they exist (one-time migration)
	// Drizzle uses camelCase column names — old tables had snake_case
	const migrationNeeded = await sql`
		SELECT column_name FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'password_hash' LIMIT 1
	`
	if (migrationNeeded.length > 0) {
		await sql`DROP TABLE IF EXISTS invites, password_reset_tokens, ai_settings, api_keys, media, content_versions, content, collections, project_members, projects, users CASCADE`
	}

	await sql`
		CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			"passwordHash" TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'editor',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS projects (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			"ownerId" UUID NOT NULL REFERENCES users(id),
			settings JSONB NOT NULL DEFAULT '{"locales":["en"],"defaultLocale":"en","mediaAdapter":"local"}',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS project_members (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			"userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role TEXT NOT NULL DEFAULT 'viewer',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE("projectId", "userId")
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS collections (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			label TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			fields JSONB NOT NULL DEFAULT '[]',
			source TEXT NOT NULL DEFAULT 'internal',
			"externalTable" TEXT,
			"accessMode" TEXT DEFAULT 'read-write',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE(name, "projectId")
		)
	`

	// Remove legacy slug column if it exists
	await sql`ALTER TABLE collections DROP COLUMN IF EXISTS slug`
	await sql`DROP INDEX IF EXISTS collections_slug_project_idx`
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS collections_name_project_idx ON collections(name, "projectId")`

	await sql`
		CREATE TABLE IF NOT EXISTS content (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			slug TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			"collectionId" UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			metadata JSONB NOT NULL DEFAULT '{}',
			markdown TEXT NOT NULL DEFAULT '',
			html TEXT NOT NULL DEFAULT '',
			locale TEXT NOT NULL DEFAULT 'en',
			version INT NOT NULL DEFAULT 1,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"publishedAt" TIMESTAMPTZ,
			"createdBy" UUID REFERENCES users(id),
			UNIQUE(slug, locale, "projectId")
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS content_versions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"contentId" UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
			version INT NOT NULL,
			markdown TEXT NOT NULL,
			metadata JSONB NOT NULL DEFAULT '{}',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"createdBy" UUID REFERENCES users(id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS media (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			type TEXT NOT NULL,
			filename TEXT NOT NULL,
			"mimeType" TEXT NOT NULL,
			size INT NOT NULL,
			url TEXT NOT NULL,
			alt TEXT,
			adapter TEXT NOT NULL DEFAULT 'local',
			"externalId" TEXT,
			metadata JSONB NOT NULL DEFAULT '{}',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"createdBy" UUID REFERENCES users(id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS api_keys (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			"keyHash" TEXT NOT NULL UNIQUE,
			"keyPrefix" TEXT NOT NULL,
			"userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			permissions JSONB NOT NULL DEFAULT '[]',
			"expiresAt" TIMESTAMPTZ,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"lastUsedAt" TIMESTAMPTZ
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS ai_settings (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
			"defaultModel" TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
			providers JSONB NOT NULL DEFAULT '[]',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS password_reset_tokens (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			"tokenHash" TEXT NOT NULL UNIQUE,
			"expiresAt" TIMESTAMPTZ NOT NULL,
			used BOOLEAN NOT NULL DEFAULT false,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS invites (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			email TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'viewer',
			"tokenHash" TEXT NOT NULL UNIQUE,
			"invitedBy" UUID NOT NULL REFERENCES users(id),
			"expiresAt" TIMESTAMPTZ NOT NULL,
			accepted BOOLEAN NOT NULL DEFAULT false,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS refresh_tokens (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			"tokenHash" TEXT NOT NULL UNIQUE,
			family TEXT NOT NULL,
			"expiresAt" TIMESTAMPTZ NOT NULL,
			revoked BOOLEAN NOT NULL DEFAULT false,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`
	await sql`CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens("userId")`
	await sql`CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family)`

	await sql`
		CREATE TABLE IF NOT EXISTS webhooks (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			url TEXT NOT NULL,
			secret TEXT NOT NULL,
			events JSONB NOT NULL DEFAULT '[]',
			active BOOLEAN NOT NULL DEFAULT true,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	// pgvector extension for semantic search (graceful fallback if unavailable)
	try {
		await sql`CREATE EXTENSION IF NOT EXISTS vector`
	} catch {
		// pgvector not available — semantic search will be disabled
	}

	await sql`
		CREATE TABLE IF NOT EXISTS content_embeddings (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"contentId" UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
			embedding vector(1536),
			"chunkIndex" INT NOT NULL DEFAULT 0,
			"chunkText" TEXT NOT NULL,
			model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`.catch(() => {
		// Table creation may fail if pgvector extension is not available
	})

	// HNSW index for fast cosine similarity search
	await sql`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON content_embeddings USING hnsw (embedding vector_cosine_ops)`.catch(() => {})

	await sql`
		CREATE TABLE IF NOT EXISTS content_analytics (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			"contentId" UUID REFERENCES content(id) ON DELETE SET NULL,
			event TEXT NOT NULL,
			query TEXT,
			source TEXT NOT NULL,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS webhook_deliveries (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			"webhookId" UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
			event TEXT NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}',
			status TEXT NOT NULL DEFAULT 'pending',
			"statusCode" INT,
			"responseBody" TEXT,
			attempts INT NOT NULL DEFAULT 0,
			"nextRetry" TIMESTAMPTZ,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	// Add columns for external DB integration (for databases created before these columns existed)
	await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'internal'`
	await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "externalTable" TEXT`
	await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "accessMode" TEXT DEFAULT 'read-write'`
	await sql`ALTER TABLE content ADD COLUMN IF NOT EXISTS "externalId" TEXT`

	await sql.end()
}

export const dbPlugin = fp(async (app) => {
	const url = process.env.DATABASE_URL
	if (!url) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('DATABASE_URL is required in production')
		}
		app.log.warn('DATABASE_URL not set — database features disabled')
		return
	}

	try {
		await ensureTables(url)
		app.log.info('Database tables ensured')
	} catch (err) {
		app.log.error(err, 'Failed to ensure database tables')
	}

	const db = createDb(url)
	app.decorate('db', db)
	app.log.info('Database connected')
})
