CREATE TYPE "public"."retrieval_policy_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint

CREATE TABLE "source_retrieval_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" "retrieval_policy_status" DEFAULT 'draft' NOT NULL,
  "document" jsonb NOT NULL,
  "created_by_api_key_id" uuid,
  "activated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "source_retrieval_policies_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  CONSTRAINT "source_retrieval_policies_source_id_sources_id_fk"
    FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade,
  CONSTRAINT "source_retrieval_policies_created_by_api_key_id_api_keys_id_fk"
    FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null
);--> statement-breakpoint

CREATE UNIQUE INDEX "source_retrieval_policies_source_version_unique"
  ON "source_retrieval_policies" USING btree ("source_id", "version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_retrieval_policies_one_active_unique"
  ON "source_retrieval_policies" USING btree ("source_id")
  WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "source_retrieval_policies_workspace_idx"
  ON "source_retrieval_policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_retrieval_policies_source_status_idx"
  ON "source_retrieval_policies" USING btree ("source_id", "status");--> statement-breakpoint

CREATE FUNCTION prevent_retrieval_policy_document_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.document IS DISTINCT FROM OLD.document
     OR NEW.created_by_api_key_id IS DISTINCT FROM OLD.created_by_api_key_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'retrieval policy versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_retrieval_policies_immutable"
  BEFORE UPDATE ON "source_retrieval_policies"
  FOR EACH ROW EXECUTE FUNCTION prevent_retrieval_policy_document_update();--> statement-breakpoint

ALTER TABLE "eval_runs" ADD COLUMN "retrieval_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_retrieval_policy_id_source_retrieval_policies_id_fk"
  FOREIGN KEY ("retrieval_policy_id") REFERENCES "public"."source_retrieval_policies"("id")
  ON DELETE set null;--> statement-breakpoint
CREATE INDEX "eval_runs_retrieval_policy_id_idx"
  ON "eval_runs" USING btree ("retrieval_policy_id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "source_retrieval_policies" TO gateway_app;--> statement-breakpoint

ALTER TABLE "source_retrieval_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_retrieval_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "source_retrieval_policies_workspace_isolation"
  ON "source_retrieval_policies" AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.workspace_id', true) IS NULL
    OR (
      workspace_id = current_setting('app.workspace_id', true)::uuid
      AND EXISTS (
        SELECT 1
        FROM sources s
        WHERE s.id = source_retrieval_policies.source_id
          AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
      )
    )
  )
  WITH CHECK (
    current_setting('app.workspace_id', true) IS NULL
    OR (
      workspace_id = current_setting('app.workspace_id', true)::uuid
      AND EXISTS (
        SELECT 1
        FROM sources s
        WHERE s.id = source_retrieval_policies.source_id
          AND s.workspace_id = current_setting('app.workspace_id', true)::uuid
      )
    )
  );
