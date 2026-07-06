import postgres from 'postgres'

/**
 * Single source of schema truth at runtime.
 *
 * The Drizzle table definitions in `./schema` are authoritative for the ORM
 * (typed queries). This function mirrors them as plain idempotent SQL and is
 * run on every API boot (and before seeding), so a container restart is all it
 * takes to bring any database — fresh or existing — up to the current schema.
 * There are no migration files: `CREATE TABLE IF NOT EXISTS` covers new installs,
 * and the `ADD COLUMN IF NOT EXISTS` / `DROP NOT NULL` block self-heals databases
 * created by an earlier version. Keep this in sync with the schema when you add a
 * table, column, or index.
 */
export async function ensureTables(connectionUrl: string) {
	const sql = postgres(connectionUrl, {
		ssl:
			connectionUrl.includes('sslmode=verify-full') || connectionUrl.includes('sslmode=require')
				? 'require'
				: false,
	})

	try {
		// ── Tables (FK-dependency order) ────────────────────────────────────────

		await sql`
			CREATE TABLE IF NOT EXISTS users (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				email TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				"passwordHash" TEXT,
				role TEXT NOT NULL DEFAULT 'editor',
				"uiLocale" TEXT,
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
				"customDomain" TEXT UNIQUE,
				"customDomainToken" TEXT,
				"customDomainVerifiedAt" TIMESTAMPTZ,
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
				"canPublishDirectly" BOOLEAN,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
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
				"titleField" TEXT,
				source TEXT NOT NULL DEFAULT 'internal',
				"externalTable" TEXT,
				"accessMode" TEXT DEFAULT 'read-write',
				"sidebarMode" TEXT NOT NULL DEFAULT 'auto',
				"lastSyncedAt" TIMESTAMPTZ,
				"lastSyncedCursor" TIMESTAMPTZ,
				"cursorColumn" TEXT,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
				"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS content (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				slug TEXT,
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
				"externalId" TEXT,
				"createdBy" UUID REFERENCES users(id)
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
				"fallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
				"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		// Instance-wide singleton holding the active license key (not project-scoped).
		await sql`
			CREATE TABLE IF NOT EXISTS license_settings (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"licenseKey" TEXT,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
				"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		// Background jobs that fill the local content cache from an external collection.
		await sql`
			CREATE TABLE IF NOT EXISTS import_jobs (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				"collectionId" UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
				"externalTable" TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				total INT,
				processed INT NOT NULL DEFAULT 0,
				checkpoint TEXT,
				error TEXT,
				"createdBy" UUID REFERENCES users(id),
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
				"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
				"startedAt" TIMESTAMPTZ,
				"completedAt" TIMESTAMPTZ
			)
		`

		// Append-only audit trail. userId is intentionally NOT a foreign key and the
		// email is denormalized so the trail survives deletion of the user it names.
		await sql`
			CREATE TABLE IF NOT EXISTS audit_logs (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"projectId" UUID REFERENCES projects(id) ON DELETE CASCADE,
				"userId" UUID,
				"userEmail" TEXT,
				action TEXT NOT NULL,
				method TEXT NOT NULL,
				path TEXT NOT NULL,
				"statusCode" INT NOT NULL,
				"resourceType" TEXT,
				"resourceId" TEXT,
				ip TEXT,
				"userAgent" TEXT,
				details JSONB,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
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
				"canPublishDirectly" BOOLEAN,
				"collectionIds" JSONB,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS refresh_tokens (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				"tokenHash" TEXT NOT NULL UNIQUE,
				"family" TEXT NOT NULL,
				"expiresAt" TIMESTAMPTZ NOT NULL,
				revoked BOOLEAN NOT NULL DEFAULT false,
				"authMethod" TEXT NOT NULL DEFAULT 'password',
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

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
			CREATE TABLE IF NOT EXISTS project_member_collections (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"memberId" UUID NOT NULL REFERENCES project_members(id) ON DELETE CASCADE,
				"collectionId" UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS sso_connections (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"projectId" UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				protocol TEXT NOT NULL,
				name TEXT NOT NULL,
				slug TEXT NOT NULL,
				enabled BOOLEAN NOT NULL DEFAULT false,
				"enforceSso" BOOLEAN NOT NULL DEFAULT false,
				"allowIdpInitiated" BOOLEAN NOT NULL DEFAULT false,
				domains TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
				"oidcIssuer" TEXT,
				"oidcClientId" TEXT,
				"oidcClientSecretEnc" TEXT,
				"oidcScopes" TEXT[] NOT NULL DEFAULT '{openid,email,profile}'::TEXT[],
				"samlEntityId" TEXT,
				"samlSsoUrl" TEXT,
				"samlIdpCertPems" TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
				"samlWantAssertionsSigned" BOOLEAN NOT NULL DEFAULT true,
				"samlWantAssertionsEncrypted" BOOLEAN NOT NULL DEFAULT false,
				"attrEmail" TEXT NOT NULL DEFAULT 'email',
				"attrName" TEXT NOT NULL DEFAULT 'name',
				"attrGroups" TEXT NOT NULL DEFAULT 'groups',
				"defaultRole" TEXT NOT NULL DEFAULT 'viewer',
				"groupRoleMap" JSONB NOT NULL DEFAULT '{}',
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
				"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS user_identities (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				"connectionId" UUID NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
				provider TEXT NOT NULL,
				subject TEXT NOT NULL,
				email TEXT,
				"rawProfile" JSONB NOT NULL DEFAULT '{}',
				"lastLoginAt" TIMESTAMPTZ,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS sso_auth_states (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				state TEXT NOT NULL UNIQUE,
				"connectionId" UUID NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
				verifier TEXT NOT NULL,
				nonce TEXT,
				next TEXT,
				intent TEXT NOT NULL DEFAULT 'login',
				"linkUserId" UUID,
				"expiresAt" TIMESTAMPTZ NOT NULL,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS sso_replay_cache (
				"responseId" TEXT PRIMARY KEY,
				"expiresAt" TIMESTAMPTZ NOT NULL,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		await sql`
			CREATE TABLE IF NOT EXISTS scim_tokens (
				id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				"connectionId" UUID NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				"tokenHash" TEXT NOT NULL UNIQUE,
				"tokenPrefix" TEXT NOT NULL,
				"createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
				"revokedAt" TIMESTAMPTZ,
				"lastUsedAt" TIMESTAMPTZ,
				"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`

		// pgvector: extension + embeddings table + HNSW index. Each step degrades
		// gracefully when the extension is unavailable — semantic search is disabled
		// but the rest of the schema still comes up.
		await sql`CREATE EXTENSION IF NOT EXISTS vector`.catch(() => {})
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
		`.catch(() => {})
		await sql`CREATE INDEX IF NOT EXISTS embeddings_content_idx ON content_embeddings("contentId")`.catch(
			() => {},
		)
		await sql`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON content_embeddings USING hnsw (embedding vector_cosine_ops)`.catch(
			() => {},
		)

		// ── Self-heal: bring databases created by an earlier schema up to date ───
		// New installs already have these from the CREATE TABLEs above; these guards
		// only do work on databases that predate the column.
		await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS "uiLocale" TEXT`
		await sql`ALTER TABLE users ALTER COLUMN "passwordHash" DROP NOT NULL`
		await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS "customDomain" TEXT`
		await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS "customDomainToken" TEXT`
		await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS "customDomainVerifiedAt" TIMESTAMPTZ`
		await sql`ALTER TABLE project_members ADD COLUMN IF NOT EXISTS "canPublishDirectly" BOOLEAN`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "titleField" TEXT`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'internal'`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "externalTable" TEXT`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "accessMode" TEXT DEFAULT 'read-write'`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "sidebarMode" TEXT NOT NULL DEFAULT 'auto'`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMPTZ`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "lastSyncedCursor" TIMESTAMPTZ`
		await sql`ALTER TABLE collections ADD COLUMN IF NOT EXISTS "cursorColumn" TEXT`
		await sql`ALTER TABLE content ADD COLUMN IF NOT EXISTS "externalId" TEXT`
		await sql`ALTER TABLE content ALTER COLUMN slug DROP NOT NULL`
		await sql`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS "fallbackEnabled" BOOLEAN NOT NULL DEFAULT false`
		await sql`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS checkpoint TEXT`
		await sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS "canPublishDirectly" BOOLEAN`
		await sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS "collectionIds" JSONB`
		await sql`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS "authMethod" TEXT NOT NULL DEFAULT 'password'`

		// ── Indexes ─────────────────────────────────────────────────────────────
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS projects_customDomain_unique ON projects("customDomain")`
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS member_project_user_idx ON project_members("projectId","userId")`
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS collections_name_project_idx ON collections(name,"projectId")`
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS content_slug_locale_project_idx ON content(slug, locale, "projectId")`
		await sql`CREATE INDEX IF NOT EXISTS content_project_collection_status_idx ON content("projectId","collectionId",status)`
		await sql`CREATE INDEX IF NOT EXISTS content_project_collection_external_idx ON content("projectId","collectionId","externalId")`
		await sql`CREATE INDEX IF NOT EXISTS content_project_status_created_idx ON content("projectId",status,"createdAt")`
		await sql`CREATE INDEX IF NOT EXISTS content_project_updated_idx ON content("projectId","updatedAt")`
		await sql`CREATE INDEX IF NOT EXISTS versions_content_idx ON content_versions("contentId",version)`
		await sql`CREATE INDEX IF NOT EXISTS media_project_type_idx ON media("projectId",type)`
		await sql`CREATE INDEX IF NOT EXISTS api_keys_project_idx ON api_keys("projectId")`
		await sql`CREATE INDEX IF NOT EXISTS import_jobs_status_idx ON import_jobs(status)`
		await sql`CREATE INDEX IF NOT EXISTS import_jobs_collection_idx ON import_jobs("collectionId")`
		await sql`CREATE INDEX IF NOT EXISTS audit_logs_project_created_idx ON audit_logs("projectId","createdAt")`
		await sql`CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens("userId")`
		await sql`CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens("family")`
		await sql`CREATE INDEX IF NOT EXISTS webhooks_project_idx ON webhooks("projectId")`
		await sql`CREATE INDEX IF NOT EXISTS deliveries_webhook_idx ON webhook_deliveries("webhookId")`
		await sql`CREATE INDEX IF NOT EXISTS deliveries_status_retry_idx ON webhook_deliveries(status,"nextRetry")`
		await sql`CREATE INDEX IF NOT EXISTS analytics_project_idx ON content_analytics("projectId")`
		await sql`CREATE INDEX IF NOT EXISTS analytics_project_event_idx ON content_analytics("projectId",event)`
		await sql`CREATE INDEX IF NOT EXISTS analytics_content_idx ON content_analytics("contentId")`
		await sql`CREATE INDEX IF NOT EXISTS analytics_created_idx ON content_analytics("createdAt")`
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS member_collection_idx ON project_member_collections("memberId","collectionId")`
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS sso_connections_project_slug_idx ON sso_connections("projectId", slug)`
		await sql`CREATE INDEX IF NOT EXISTS sso_connections_project_idx ON sso_connections("projectId")`
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS user_identities_conn_subject_idx ON user_identities("connectionId", subject)`
		await sql`CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities("userId")`
		await sql`CREATE INDEX IF NOT EXISTS sso_auth_states_expires_idx ON sso_auth_states("expiresAt")`
		await sql`CREATE INDEX IF NOT EXISTS sso_replay_cache_expires_idx ON sso_replay_cache("expiresAt")`
		await sql`CREATE INDEX IF NOT EXISTS scim_tokens_conn_idx ON scim_tokens("connectionId")`

		// Case-insensitive unique email. Guarded on its own so that a legacy database
		// carrying case-variant duplicate emails (created before write-time
		// normalization) logs a warning instead of aborting the whole DDL run. New
		// writes normalize email to lowercase, so duplicates can't accumulate.
		try {
			await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users(lower(email))`
		} catch (err) {
			console.warn(
				'[ensure] Could not create users_email_lower_idx (likely pre-existing case-variant duplicate emails); resolve manually.',
				err,
			)
		}
	} finally {
		await sql.end()
	}
}
