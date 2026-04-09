import { createDb, type Database } from '@innolope/db'
import fp from 'fastify-plugin'
import postgres from 'postgres'

declare module 'fastify' {
	interface FastifyInstance {
		db: Database
	}
}

// Auto-create tables if they don't exist (safe for CockroachDB + PostgreSQL)
async function ensureTables(connectionUrl: string) {
	const sql = postgres(connectionUrl, {
		ssl: connectionUrl.includes('sslmode=verify-full') || connectionUrl.includes('sslmode=require')
			? 'require'
			: false,
	})

	// Create tables in dependency order
	await sql`
		CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'editor',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS projects (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name TEXT NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			owner_id UUID NOT NULL REFERENCES users(id),
			settings JSONB NOT NULL DEFAULT '{"locales":["en"],"defaultLocale":"en","mediaAdapter":"local"}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS project_members (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role TEXT NOT NULL DEFAULT 'viewer',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE(project_id, user_id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS collections (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			slug TEXT NOT NULL,
			description TEXT,
			fields JSONB NOT NULL DEFAULT '[]',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE(slug, project_id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS content (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			slug TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
			metadata JSONB NOT NULL DEFAULT '{}',
			markdown TEXT NOT NULL DEFAULT '',
			html TEXT NOT NULL DEFAULT '',
			locale TEXT NOT NULL DEFAULT 'en',
			version INT NOT NULL DEFAULT 1,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			published_at TIMESTAMPTZ,
			created_by UUID REFERENCES users(id),
			UNIQUE(slug, locale, project_id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS content_versions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
			version INT NOT NULL,
			markdown TEXT NOT NULL,
			metadata JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			created_by UUID REFERENCES users(id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS media (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			type TEXT NOT NULL,
			filename TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			size INT NOT NULL,
			url TEXT NOT NULL,
			alt TEXT,
			adapter TEXT NOT NULL DEFAULT 'local',
			external_id TEXT,
			metadata JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			created_by UUID REFERENCES users(id)
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS api_keys (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			key_prefix TEXT NOT NULL,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			permissions JSONB NOT NULL DEFAULT '[]',
			expires_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			last_used_at TIMESTAMPTZ
		)
	`

	await sql`
		CREATE TABLE IF NOT EXISTS ai_settings (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
			default_model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
			providers JSONB NOT NULL DEFAULT '[]',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`

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

	// Auto-create tables on startup
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
