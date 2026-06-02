CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid,
	"userId" uuid,
	"userEmail" text,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"statusCode" integer NOT NULL,
	"resourceType" text,
	"resourceId" text,
	"ip" text,
	"userAgent" text,
	"details" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- IF NOT EXISTS: `0009_configurable_review_workflow.sql` may already have added this
-- column out-of-band. This keeps the column in Drizzle's tracked migration history
-- so a fresh `drizzle-kit migrate` (which skips the un-journaled file) still creates it.
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "canPublishDirectly" boolean;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_project_created_idx" ON "audit_logs" USING btree ("projectId","createdAt");