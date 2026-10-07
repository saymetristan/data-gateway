# CSV ingestion in database batches

## Scope and plan

- Classification: F + DB (persistent-query implementation), local preparation only.
- Current base: `f474f03b7170f156edd51705809c53a1daf276e9` (`origin/main`); branch `fix/csv-bulk-ingestion`. Initially prepared on `7adeeb8c929d87777492bac66a5ec7e532941447`.
- Problem: a 39,796-row publication completed after 311.979 seconds while its caller received HTTP 524. CSV ingestion currently performs a serial hash lookup and, for changed rows, an upsert for every row.
- Replace those per-row database round trips with scoped hash reads and bounded Drizzle bulk upserts in the existing CSV/raw-record services.
- Preserve the public response, `payloadHash` fingerprint, source/workspace authorization, final duplicate-ID payload and imported-count semantics, unchanged-row timestamps, and stale-row deletion only after every input row succeeds.
- Keep existing profiling admission after successful ingestion. No migration, new endpoint, async protocol, remote DB operation, or infrastructure change.

## Validation plan

Use targeted local database tests for identical/changed payloads, duplicate identifiers, source isolation, no false deletions, and failure before stale cleanup. Verify bounded statement counts with a representative large CSV. Run core/API type checks and builds plus lint for affected files only.

## Delivery boundary

A local commit and rebase were subsequently authorized. No push, deployment, or production verification is included. Production approval is required because this exceeds the previously authorized timeout-only Gateway change.

## Local result — 2026-09-26 21:17 America/Mexico_City

- Implemented one source-scoped hash read and bulk upserts of at most 500 distinct identifiers. The existing single-row writer remains unchanged. Duplicate identifiers retain sequential imported-count semantics and their final payload, including a change that returns to the original hash.
- Targeted `csv.test.ts`: 5/5 passed against disposable PostgreSQL 17 + pgvector databases on local port 55440. Profiling queue admission is mocked; SQL, constraints, upserts and cleanup execute against the real database.
- The 39,796-row test performs initial ingestion, changes every row, and repeats the identical payload. The changed upload executes exactly 80 raw INSERT statements and two raw SELECT statements (hash lookup and existing cleanup). That complete test took 3.923 seconds locally; this is not a production latency prediction.
- Verified identical content preserves IDs, createdAt and syncedAt; changed content retains IDs/createdAt; duplicate transitions, workspace rejection, source isolation, indexed-record retention/deletion, and empty CSV behavior are covered.
- A real CHECK violation in the second batch preserves the first batch and stale raw/indexed rows, and does not advance source timestamps or admit profiling.
- Passed: core/API `typecheck` and `build`, ESLint for `csv.ts` and `raw-records.ts`, and `git diff --check`.
- Remaining limits: uploads are not globally transactional and same-source concurrent uploads receive no new serialization guarantee, as before. Stale-record deletion still uses the existing per-record implementation; this change optimizes the reproduced same-ID full-update path. Source hashes and pending payloads are held in memory alongside the already parsed CSV. Production latency and caller completion require approved deployment and an actual upload.

## Review and cleanup — 2026-09-26 21:20 America/Mexico_City

- Independent review approved with no findings, as confirmed by the coordinating agent. Production authorization remains pending; no commit or deployment was performed.
- Removed the disposable `dg-csv-bulk-test` container and its anonymous PostgreSQL volume. No other containers were active; returned Colima to its prior stopped state and restored the prior default Docker context. Other resources were preserved.

## Local integration after review

- Preserved the reviewed bulk diff in one local commit and rebased cleanly onto `origin/main` at `f474f03b7170f156edd51705809c53a1daf276e9`. The deployed exact-search-ranking changes remain intact; they touch independent retrieval/query files. The equivalent upload-timeout commit already present upstream was correctly skipped by Git.
- Review approval remains applicable: no bulk implementation or test content changed during rebase. Verified the resulting diff contains only the three reviewed CSV/raw-record files and this record, with no conflict or shared contract change. `git diff --check` passed. Database tests and builds were not repeated for this independent clean rebase.
- Working tree retained locally; no push, merge to the remote main branch, deployment, or production authorization.

## Authorized production delivery — 2026-09-26T22:43:28-06:00

- Tris authorized deployment and normal-path verification of this bulk fix. Classification F + DB + Plat; no schema change.
- Target: Data Gateway project be49c553-4d7d-445d-935e-f8a603e15c2d, production 57adb1ff-0cb9-4241-a282-e6a9efb5cd5a, API f3dd7666-671c-4393-8de9-f8e1f4495c59. API-only deployment avoids restarting the shared indexing worker.
- Verified current API revision f474f03. Rollback: redeploy that prior API revision; completed data is retained, not rolled back.
- Release checks reuse the reviewed five PostgreSQL tests and successful core/API types/build/lint; code and dependency graph have not changed since verification.
- Verify through QSS portal import/publication, with 39,796 same-commercial-value records, then confirm searchable versions. No replay on uncertain upload.
