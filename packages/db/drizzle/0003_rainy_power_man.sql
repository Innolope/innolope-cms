ALTER TABLE "projects" ADD COLUMN "customDomain" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "customDomainToken" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "customDomainVerifiedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customDomain_unique" UNIQUE("customDomain");