ALTER TABLE "collections" ADD COLUMN "lastSyncedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "lastSyncedCursor" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "cursorColumn" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "checkpoint" text;
