# Incident: Bayon HTTP 500 from invalid retrieval policy

- Change type: P + S (hotfix) + production ops
- Related: `0009_retrieval_policies`, commit `dea86bd`
- Human gate: restore Bayon search after production 500s

## Cause

The Bayon retrieval policy v1 inserted during the initial rollout contained accent-equivalent keys (`cuadrille`/`cuadrillé`, `caneva`/`canevá`) and self-synonyms after normalization. Query-time loading called `retrievalPolicyDocumentSchema.parse()` on the active document, so every `search_variant` / `/query` for Bayon threw an unhandled `ZodError` and returned HTTP 500. Healthchecks and sync jobs were unaffected.

## Contención

1. Archived policy v1 (`e3e1b3c0-e88d-4966-8fdc-dd7aefada04a`) in Supabase so the query path fell back to mapping synonyms (`bayon-fabrics-v3`).
2. Confirmed source stayed `agent_ready` with 4,068 records and 4,068 embeddings.

## Hotfix

- [`packages/core/src/services/retrieval-policies.ts`](../../../packages/core/src/services/retrieval-policies.ts): fail-open `safeParse` for active policies; invalid documents are ignored with a warning.
- Eval/override path still rejects invalid documents with `400 validation`.
- Regression tests cover accent-duplicate payloads and the Bayon fixture.

## Valid policy restore

- Created policy draft v2 from `fixtures/bayon-retrieval-policy.json` via API.
- Eval run `c042ab41-0cc5-4caa-9e02-7741dfe77013`: `score ≈ 0.923` (12/13), `sensitiveLeaks = 0`.
- Activated policy v2 (`status=active`). Policy v1 remains archived.

## Evidence

- Smoke queries after containment/activation: `Aida`, `cuadrillé`, long craft query → HTTP 200, top hit `Cuadrille Aida`.
- Railway: api/worker deploy `dea86bd` SUCCESS; API `/health` ok.
- Temporary smoke API keys revoked.

## Rollback

- Operational: activate a previously validated policy version, or archive the active policy to fall back to mapping synonyms.
- Code: revert `dea86bd` only if fail-open behavior must be removed; do not re-activate an invalid document.
