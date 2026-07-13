CREATE TABLE "query_embedding_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"query_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dims" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_embedding_cache" ADD CONSTRAINT "query_embedding_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "query_embedding_cache_ws_hash_model_dims_unique" ON "query_embedding_cache" USING btree ("workspace_id","query_hash","embedding_model","embedding_dims");
--> statement-breakpoint
CREATE INDEX "query_embedding_cache_expires_at_idx" ON "query_embedding_cache" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "query_embedding_cache_workspace_id_idx" ON "query_embedding_cache" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "query_logs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "query_embedding_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "query_embedding_cache" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "query_embedding_cache_workspace_isolation" ON "query_embedding_cache";
--> statement-breakpoint
CREATE POLICY "query_embedding_cache_workspace_isolation" ON "query_embedding_cache" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "query_embedding_cache" TO gateway_app;
