# Tractodiesel descriptive search quality

- Change type: P + DB + Plat
- Issue: https://github.com/saymetristan/data-gateway/issues/11
- Environment: local, CI, Railway production, Supabase `data-ingest`
- Production gate: pending explicit approval

## Problem

Hybrid retrieval returned semantically incompatible products for descriptive
catalog queries. The response already exposed `results[].score`, but that value
was raw RRF output, did not account for per-field term coverage, and could not
support a deterministic weak-hit cutoff.

The eval contract also could not assert forbidden IDs in the top K, empty/weak
responses, or required visible identifier fields.

## Change

- Normalize per-hit relevance to `0..1` from retrieval rank, vector similarity,
  weighted concept coverage, and primary (`searchWeight: A`) field coverage.
- Treat source synonyms as concept alternatives instead of independent required
  terms.
- Add opt-in policy thresholds `minRelevance` and
  `minPrimaryFieldCoverage`; exact identifier matches bypass pruning.
- Wire retrieval-policy `valueAliases` to canonical profile values.
- Add eval assertions `mustNotAppearInTop`, `maxResultCount`,
  `maxConfidence`, and `mustContainFields`.
- Add an additive migration for the new eval-case fields.

## Verification

- Focused ranking/eval unit tests: 54 passed.
- `pnpm typecheck`, `pnpm lint`, and `pnpm test`: passed (196 tests;
  database integration suites skipped because local Docker was unavailable).
- PR and CI: pending.
- Production migration, deploy, policy eval, activation, and smoke tests:
  pending human gate.

## Rollback

- Archive the new retrieval policy and reactivate the prior version.
- Redeploy the prior API and worker releases.
- The additive nullable eval columns may remain; old binaries ignore them.
