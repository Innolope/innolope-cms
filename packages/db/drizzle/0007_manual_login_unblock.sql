-- Hand-trimmed from a drizzle-kit generate run. The auto-generated file
-- re-emitted statements already shipped in 0001 / 0005 / 0006 because those
-- earlier migrations were hand-written and never produced snapshot JSONs
-- under drizzle/meta/, so drizzle-kit's diff didn't see them as applied.
--
-- This file captures exactly what was applied as raw SQL on prod to unblock
-- /auth/me (uiLocale missing) and to support the parallel collection-access
-- + per-collection titleField work. Statements are idempotent so re-running
-- locally is safe.
--
-- Reconciliation on prod is OPTIONAL — once DB_STRATEGY=reset ships, the
-- migration ledger stops mattering. If you do want to reconcile, the recipe
-- lives in the project-deployment-topology memory note.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "uiLocale" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "titleField" text;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "sidebarMode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "project_member_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memberId" uuid NOT NULL,
	"collectionId" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "project_member_collections" ADD CONSTRAINT "project_member_collections_memberId_project_members_id_fk"
		FOREIGN KEY ("memberId") REFERENCES "public"."project_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "project_member_collections" ADD CONSTRAINT "project_member_collections_collectionId_collections_id_fk"
		FOREIGN KEY ("collectionId") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "member_collection_idx"
	ON "project_member_collections" USING btree ("memberId","collectionId");
