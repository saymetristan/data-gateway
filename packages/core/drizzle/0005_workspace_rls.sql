-- RLS: defensa en profundidad por workspace_id.
-- gateway_app no tiene BYPASSRLS; la API hace SET LOCAL ROLE gateway_app en requests workspace.

DO $$ BEGIN
  CREATE ROLE gateway_app NOINHERIT NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
GRANT gateway_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO gateway_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gateway_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gateway_app;--> statement-breakpoint

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_workspace_isolation" ON "workspaces";--> statement-breakpoint
CREATE POLICY "workspaces_workspace_isolation" ON "workspaces" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "api_keys_workspace_isolation" ON "api_keys";--> statement-breakpoint
CREATE POLICY "api_keys_workspace_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "sources_workspace_isolation" ON "sources";--> statement-breakpoint
CREATE POLICY "sources_workspace_isolation" ON "sources" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "records_workspace_isolation" ON "records";--> statement-breakpoint
CREATE POLICY "records_workspace_isolation" ON "records" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "query_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "query_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "query_logs_workspace_isolation" ON "query_logs";--> statement-breakpoint
CREATE POLICY "query_logs_workspace_isolation" ON "query_logs" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "eval_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_sets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "eval_sets_workspace_isolation" ON "eval_sets";--> statement-breakpoint
CREATE POLICY "eval_sets_workspace_isolation" ON "eval_sets" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (current_setting('app.workspace_id', true) IS NULL OR workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint

ALTER TABLE "mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mappings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "mappings_workspace_isolation" ON "mappings";--> statement-breakpoint
CREATE POLICY "mappings_workspace_isolation" ON "mappings" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = mappings.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = mappings.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "source_records_raw" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_records_raw" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "source_records_raw_workspace_isolation" ON "source_records_raw";--> statement-breakpoint
CREATE POLICY "source_records_raw_workspace_isolation" ON "source_records_raw" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_records_raw.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_records_raw.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "source_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "source_profiles_workspace_isolation" ON "source_profiles";--> statement-breakpoint
CREATE POLICY "source_profiles_workspace_isolation" ON "source_profiles" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_profiles.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_profiles.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "record_enrichments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_enrichments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "record_enrichments_workspace_isolation" ON "record_enrichments";--> statement-breakpoint
CREATE POLICY "record_enrichments_workspace_isolation" ON "record_enrichments" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = record_enrichments.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = record_enrichments.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "source_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_transitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "source_transitions_workspace_isolation" ON "source_transitions";--> statement-breakpoint
CREATE POLICY "source_transitions_workspace_isolation" ON "source_transitions" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_transitions.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = source_transitions.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "webhook_events_workspace_isolation" ON "webhook_events";--> statement-breakpoint
CREATE POLICY "webhook_events_workspace_isolation" ON "webhook_events" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = webhook_events.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM sources s
      WHERE s.id = webhook_events.source_id
        AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "record_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_embeddings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "record_embeddings_workspace_isolation" ON "record_embeddings";--> statement-breakpoint
CREATE POLICY "record_embeddings_workspace_isolation" ON "record_embeddings" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM records r
      WHERE r.id = record_embeddings.record_id
        AND r.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM records r
      WHERE r.id = record_embeddings.record_id
        AND r.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "eval_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "eval_cases_workspace_isolation" ON "eval_cases";--> statement-breakpoint
CREATE POLICY "eval_cases_workspace_isolation" ON "eval_cases" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM eval_sets es
      WHERE es.id = eval_cases.eval_set_id
        AND es.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM eval_sets es
      WHERE es.id = eval_cases.eval_set_id
        AND es.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "eval_runs_workspace_isolation" ON "eval_runs";--> statement-breakpoint
CREATE POLICY "eval_runs_workspace_isolation" ON "eval_runs" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM eval_sets es
      WHERE es.id = eval_runs.eval_set_id
        AND es.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM eval_sets es
      WHERE es.id = eval_runs.eval_set_id
        AND es.workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );
