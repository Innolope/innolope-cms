-- Configurable review workflow + per-member publish permission.
--
-- Adds `canPublishDirectly` to `project_members` and `invites`. NULL means
-- "fall back to the project default" (review on/off + role-based default for
-- the user's role); TRUE/FALSE are explicit per-member overrides.
--
-- The project-wide `settings.requireReview` flag is stored inside the
-- existing `projects.settings` JSONB blob; no column migration needed for it.
-- The auto-default ("review = off when project has 1 member") lives in the
-- /projects POST handler so existing projects keep their current behaviour
-- until an admin changes it.
--
-- Statements are idempotent so re-running locally is safe.

ALTER TABLE "project_members"
	ADD COLUMN IF NOT EXISTS "canPublishDirectly" boolean;--> statement-breakpoint

ALTER TABLE "invites"
	ADD COLUMN IF NOT EXISTS "canPublishDirectly" boolean;
