CREATE TABLE "source_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"profiled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "records" DROP COLUMN "search_text";
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "search_source" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('es_unaccent', public.f_unaccent(coalesce(search_source, '')))) STORED;
--> statement-breakpoint
ALTER TABLE "source_profiles" ADD CONSTRAINT "source_profiles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "record_enrichments" ADD CONSTRAINT "record_enrichments_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "source_profiles_source_id_unique" ON "source_profiles" USING btree ("source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "record_enrichments_cache_unique" ON "record_enrichments" USING btree ("source_id","source_record_id","payload_hash","prompt_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "record_embeddings_record_model_version_unique" ON "record_embeddings" USING btree ("record_id","embedding_model","mapping_version");
--> statement-breakpoint
CREATE INDEX "records_search_text_idx" ON "records" USING gin ("search_text");
