CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"collectionId" uuid NOT NULL,
	"externalTable" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total" integer,
	"processed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"createdBy" uuid,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_collectionId_collections_id_fk" FOREIGN KEY ("collectionId") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_status_idx" ON "import_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "import_jobs_collection_idx" ON "import_jobs" USING btree ("collectionId");--> statement-breakpoint
CREATE INDEX "content_project_collection_external_idx" ON "content" USING btree ("projectId","collectionId","externalId");