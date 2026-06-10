CREATE TYPE "public"."webhook_event_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"webhook_id" text NOT NULL,
	"status" "webhook_event_status" DEFAULT 'processing' NOT NULL,
	"topic" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT '{"*"}';--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = '{"*"}', "updated_at" = now() WHERE "scopes" = '{}';--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_webhook_unique" ON "webhook_events" USING btree ("provider","webhook_id");--> statement-breakpoint
CREATE INDEX "webhook_events_source_id_idx" ON "webhook_events" USING btree ("source_id");