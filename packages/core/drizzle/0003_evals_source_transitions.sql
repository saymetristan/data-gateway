CREATE TYPE "public"."eval_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "source_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"from_status" "maturity_status" NOT NULL,
	"to_status" "maturity_status" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "status" SET DATA TYPE "public"."eval_run_status" USING "status"::"public"."eval_run_status";--> statement-breakpoint
ALTER TABLE "eval_sets" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "source_transitions" ADD CONSTRAINT "source_transitions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_transitions_source_id_idx" ON "source_transitions" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "eval_sets" ADD CONSTRAINT "eval_sets_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_sets_source_id_idx" ON "eval_sets" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_sets_workspace_source_unique" ON "eval_sets" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_sets_workspace_global_unique" ON "eval_sets" USING btree ("workspace_id") WHERE "eval_sets"."source_id" IS NULL;