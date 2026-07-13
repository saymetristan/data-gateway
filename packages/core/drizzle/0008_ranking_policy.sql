-- Weighted lexical search + eval ranking assertions
ALTER TABLE "records" ADD COLUMN IF NOT EXISTS "search_weights" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "records_search_text_idx";--> statement-breakpoint
ALTER TABLE "records" DROP COLUMN IF EXISTS "search_text";--> statement-breakpoint
ALTER TABLE "records" ADD COLUMN "search_text" tsvector GENERATED ALWAYS AS (
  CASE
    WHEN coalesce(search_weights->>'A', '') = ''
     AND coalesce(search_weights->>'B', '') = ''
     AND coalesce(search_weights->>'C', '') = ''
     AND coalesce(search_weights->>'D', '') = ''
    THEN to_tsvector('es_unaccent', public.f_unaccent(coalesce(search_source, '')))
    ELSE
      setweight(to_tsvector('es_unaccent', public.f_unaccent(coalesce(search_weights->>'A', ''))), 'A')
      || setweight(to_tsvector('es_unaccent', public.f_unaccent(coalesce(search_weights->>'B', ''))), 'B')
      || setweight(to_tsvector('es_unaccent', public.f_unaccent(coalesce(search_weights->>'C', ''))), 'C')
      || setweight(to_tsvector('es_unaccent', public.f_unaccent(coalesce(search_weights->>'D', ''))), 'D')
  END
) STORED;--> statement-breakpoint
CREATE INDEX "records_search_text_idx" ON "records" USING gin ("search_text");--> statement-breakpoint

ALTER TABLE "eval_cases" ADD COLUMN IF NOT EXISTS "must_rank_above" jsonb;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN IF NOT EXISTS "expected_top_ids" jsonb;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN IF NOT EXISTS "must_apply_preferences" jsonb;