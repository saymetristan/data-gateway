CREATE TYPE "public"."maturity_status" AS ENUM('connected', 'profiled', 'indexed', 'mapped', 'validated', 'agent_ready');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('database_url', 'csv', 'shopify');--> statement-breakpoint
CREATE TYPE "public"."mapping_status" AS ENUM('draft', 'active');--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "source_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"maturity_status" "maturity_status" DEFAULT 'connected' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_records_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"status" "mapping_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"external_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mapping_version" integer DEFAULT 0 NOT NULL,
	"search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('es_unaccent', public.f_unaccent(
        coalesce(data->>'name', '') || ' ' ||
        coalesce(data->>'description', '') || ' ' ||
        coalesce(data->>'title', '') || ' ' ||
        coalesce(data->>'sku', '')
      ))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dims" integer DEFAULT 1024 NOT NULL,
	"mapping_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"api_key_id" uuid,
	"source_id" uuid,
	"raw_query" text,
	"structured_query" jsonb,
	"query_type" text,
	"applied_filters" jsonb,
	"results_count" integer,
	"confidence" double precision,
	"latency_ms" integer,
	"warnings" jsonb DEFAULT '[]'::jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_set_id" uuid NOT NULL,
	"query" text NOT NULL,
	"expected_result_ids" jsonb,
	"must_apply_filters" jsonb,
	"must_not_contain_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_set_id" uuid NOT NULL,
	"status" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"passed" jsonb,
	"failed" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"threshold" double precision DEFAULT 0.8 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records_raw" ADD CONSTRAINT "source_records_raw_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mappings" ADD CONSTRAINT "mappings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_embeddings" ADD CONSTRAINT "record_embeddings_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_logs" ADD CONSTRAINT "query_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_set_id_eval_sets_id_fk" FOREIGN KEY ("eval_set_id") REFERENCES "public"."eval_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_sets" ADD CONSTRAINT "eval_sets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sources_workspace_id_idx" ON "sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sources_workspace_maturity_idx" ON "sources" USING btree ("workspace_id","maturity_status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_raw_source_record_unique" ON "source_records_raw" USING btree ("source_id","source_record_id");--> statement-breakpoint
CREATE INDEX "source_records_raw_source_id_idx" ON "source_records_raw" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mappings_source_version_unique" ON "mappings" USING btree ("source_id","version");--> statement-breakpoint
CREATE INDEX "mappings_source_id_idx" ON "mappings" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "records_source_entity_external_unique" ON "records" USING btree ("source_id","entity","external_id");--> statement-breakpoint
CREATE INDEX "records_workspace_id_idx" ON "records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "records_workspace_entity_idx" ON "records" USING btree ("workspace_id","entity");--> statement-breakpoint
CREATE INDEX "records_search_text_idx" ON "records" USING gin ("search_text");--> statement-breakpoint
CREATE INDEX "records_data_idx" ON "records" USING gin ("data");--> statement-breakpoint
CREATE INDEX "record_embeddings_record_id_idx" ON "record_embeddings" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "record_embeddings_embedding_hnsw_idx" ON "record_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "query_logs_workspace_id_idx" ON "query_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "query_logs_created_at_idx" ON "query_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "eval_cases_eval_set_id_idx" ON "eval_cases" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX "eval_runs_eval_set_id_idx" ON "eval_runs" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX "eval_sets_workspace_id_idx" ON "eval_sets" USING btree ("workspace_id");