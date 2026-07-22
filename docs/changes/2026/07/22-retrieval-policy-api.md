# Retrieval policy API

- Change type: P + DB + S
- Migration: `0009_retrieval_policies.sql`
- Public contract: versioned synonym policies with `retrieval:read` / `retrieval:write`
- Runtime effect: query-time synonym override only; no index, embedding, or source-maturity mutation

## Data changes

Adds `source_retrieval_policies` with tenant ownership, immutable version numbers, one-active-per-source constraint and RLS. Adds nullable `eval_runs.retrieval_policy_id` so every policy validation is auditable.

## Rollback

Operational rollback is preferred: activate the previous validated policy version. This is O(1) and preserves history.

Before reverting the migration, stop API/worker versions that read retrieval policies. Database rollback order:

1. Drop `eval_runs_retrieval_policy_id_idx`, its FK, and the column.
2. Drop `source_retrieval_policies` and `prevent_retrieval_policy_document_update()`.
3. Drop `retrieval_policy_status`.

Dropping the table removes policy history and is destructive; export it first if a code rollback requires removing the migration.

## Verification

- Schema validation covers duplicates, self-synonyms, entity uniqueness and normalized vocabulary.
- Service/API tests cover scopes, tenancy, versioning, activation and restoring a validated version.
- Integration assertions confirm records, embeddings, transitions and `agent_ready` remain unchanged.

## Production apply (2026-07-22)

- Migration `0009_retrieval_policies` applied via `data-gateway-supabase` (`20260722220647`).
- Commit `d2aa93d` pushed to `main`; Railway `api` / `worker` redeployed successfully.
- Bayon source `437259e4-9ee3-4f8d-a8bf-7411d769b9a0` kept `agent_ready` with 4,068 records and 4,068 embeddings.
- Active mapping synonyms patched in place to `bayon-fabrics-v3` (mapping version stayed `4`; no reindex).
- Retrieval policy v1 activated for Bayon with the same craft vocabulary.
- Craft eval cases (Aida / cuadrillé / etamina / long query) seeded into Bayon Shopify QA.
