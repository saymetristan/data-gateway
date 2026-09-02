# Tractodiesel descriptive search quality

- Change type: P + DB + Plat
- Issue: https://github.com/saymetristan/data-gateway/issues/11
- Environment: local, CI, Railway production, Supabase `data-ingest`
- Production gate: approved 2026-09-02

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
- Penalize explicit presentation conflicts (`19 L` vs `200 L`, `4T` vs
  `2 tiempos`) and reserve lexical branch capacity for identifier-like policy
  aliases.

## Verification

- Local: `pnpm typecheck`, `pnpm lint`, and `pnpm test` passed (197 tests;
  database integration suites skipped locally because Docker was unavailable).
- CI passed, including database integration, on PRs
  [#12](https://github.com/saymetristan/data-gateway/pull/12),
  [#13](https://github.com/saymetristan/data-gateway/pull/13),
  [#14](https://github.com/saymetristan/data-gateway/pull/14), and rollback
  [#17](https://github.com/saymetristan/data-gateway/pull/17).
- Experimental PRs
  [#15](https://github.com/saymetristan/data-gateway/pull/15) and
  [#16](https://github.com/saymetristan/data-gateway/pull/16) regressed the
  production eval and were reverted by #17.
- Supabase migration `20260902011453 add_eval_search_quality_assertions`
  applied successfully.
- Final production revision: `cf1a67d`; API deployment
  `ff0a1af4-7400-4b12-8d0f-8e99c2976e39` and worker deployment
  `461f279c-2811-4067-b3f6-49c0850e2a6a` succeeded.
- Retrieval policy v8 is active. Final eval run
  `acf7e705-9633-4388-8a34-2195b97445f9` passed the `0.8` gate with score
  `0.8064516129`, precision@k `0.8537634409`, filter accuracy `1`, and zero
  sensitive leaks.
- Final smoke:
  - Sensor: `4902720P-IMP` (`0.9917`), `4902720` (`0.9824`) lead; known
    distractors are absent.
  - Mobil 19 L: top 3 contains no forbidden 1/5/200 L variants or `64195-N`;
    `1300` scores `0.7288`.
  - Motorcycle 4T: `6422` (`0.9945`), `P7400` (`0.9907`), and `C120`
    (`0.9832`) lead; 2T and contaminated `06416` are absent.
- `/ready` returned database and worker ready. The temporary rollout key was
  revoked at `2026-09-02T02:56:58Z`.

## Rollback

- Archive the new retrieval policy and reactivate the prior version.
- Redeploy the prior API and worker releases.
- The additive nullable eval columns may remain; old binaries ignore them.
