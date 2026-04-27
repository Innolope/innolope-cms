-- SSO: nullable password for SSO-only users
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "refresh_tokens" ADD COLUMN "authMethod" text DEFAULT 'password' NOT NULL;
--> statement-breakpoint

CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"protocol" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enforceSso" boolean DEFAULT false NOT NULL,
	"allowIdpInitiated" boolean DEFAULT false NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"oidcIssuer" text,
	"oidcClientId" text,
	"oidcClientSecretEnc" text,
	"oidcScopes" text[] DEFAULT '{openid,email,profile}'::text[] NOT NULL,
	"samlEntityId" text,
	"samlSsoUrl" text,
	"samlIdpCertPems" text[] DEFAULT '{}'::text[] NOT NULL,
	"samlWantAssertionsSigned" boolean DEFAULT true NOT NULL,
	"samlWantAssertionsEncrypted" boolean DEFAULT false NOT NULL,
	"attrEmail" text DEFAULT 'email' NOT NULL,
	"attrName" text DEFAULT 'name' NOT NULL,
	"attrGroups" text DEFAULT 'groups' NOT NULL,
	"defaultRole" text DEFAULT 'viewer' NOT NULL,
	"groupRoleMap" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "sso_connections"
	ADD CONSTRAINT "sso_connections_projectId_fk"
	FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE UNIQUE INDEX "sso_connections_project_slug_idx" ON "sso_connections" ("projectId","slug");
--> statement-breakpoint
CREATE INDEX "sso_connections_project_idx" ON "sso_connections" ("projectId");
--> statement-breakpoint

CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"connectionId" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"rawProfile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lastLoginAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "user_identities"
	ADD CONSTRAINT "user_identities_userId_fk"
	FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "user_identities"
	ADD CONSTRAINT "user_identities_connectionId_fk"
	FOREIGN KEY ("connectionId") REFERENCES "sso_connections"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE UNIQUE INDEX "user_identities_conn_subject_idx" ON "user_identities" ("connectionId","subject");
--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" ("userId");
--> statement-breakpoint

CREATE TABLE "sso_auth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"connectionId" uuid NOT NULL,
	"verifier" text NOT NULL,
	"nonce" text,
	"next" text,
	"intent" text DEFAULT 'login' NOT NULL,
	"linkUserId" uuid,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_auth_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint

ALTER TABLE "sso_auth_states"
	ADD CONSTRAINT "sso_auth_states_connectionId_fk"
	FOREIGN KEY ("connectionId") REFERENCES "sso_connections"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX "sso_auth_states_expires_idx" ON "sso_auth_states" ("expiresAt");
--> statement-breakpoint

CREATE TABLE "sso_replay_cache" (
	"responseId" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "sso_replay_cache_expires_idx" ON "sso_replay_cache" ("expiresAt");
--> statement-breakpoint

CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"name" text NOT NULL,
	"tokenHash" text NOT NULL,
	"tokenPrefix" text NOT NULL,
	"createdBy" uuid,
	"revokedAt" timestamp with time zone,
	"lastUsedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint

ALTER TABLE "scim_tokens"
	ADD CONSTRAINT "scim_tokens_connectionId_fk"
	FOREIGN KEY ("connectionId") REFERENCES "sso_connections"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "scim_tokens"
	ADD CONSTRAINT "scim_tokens_createdBy_fk"
	FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX "scim_tokens_conn_idx" ON "scim_tokens" ("connectionId");
