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
- Production migration and deployment require explicit human confirmation.
