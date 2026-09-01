# Incident: Data Gateway query-path degradation

- Change type: I + DB + Plat
- Environment: Railway production + Supabase `data-ingest`
- Human gate: recovery plan approved on 2026-08-31

## Impact

`GET /sources/:id/status`, `POST /query`, and `POST /tools/:name/invoke`
intermittently returned HTTP 504 at the 25-second request timeout. Liveness
remained green because `/health` only checked `SELECT 1`.

## Cause

A version-4 reindex of source `1653b6d2-277f-4353-8131-366b76560eca`
expanded roughly 145,000 records into thousands of 50-record embedding jobs.
Overlapping source-index jobs amplified the queue from 2,909 to 14,357 jobs.

Each embedding job opened a new pool, wrote vectors one row at a time, and
scanned the source to purge stale embeddings. This saturated PostgreSQL I/O
while autovacuum spent more than 25 hours vacuuming the 1.8 GB HNSW index.
`record_embeddings` was 2.7 GB with approximately 42% dead tuples.

## Containment

1. Added and enabled `WORKER_INGESTION_PAUSED=true` for the Railway worker.
2. Deployed worker deployment `7c7683dc-2a45-4add-a6f9-5212c610e889`.
3. Confirmed source, index, and embedding consumers were not registered while
   heartbeat and cache-maintenance jobs remained available.
4. Deployed API deployment `1aabfa25-31e6-4762-87cc-95b4fa5c8c38`.
5. Confirmed `/health` and `/ready` both returned HTTP 200 after the API hotfix.

The Supabase management role could not cancel the superuser-owned autovacuum.
An operator Fast database reboot on 2026-09-01 released the stuck vacuum.
pgvector cannot be upgraded: this project only exposes `vector` 0.8.0.

## Hotfix

- Deduplicate every `source.index` producer with a shared singleton window.
- Increase queue job size while keeping OpenRouter requests at 50 inputs.
- Bulk-upsert each provider batch and purge stale vectors only for written IDs.
- Reuse a small worker database pool and use ingest-specific DB/provider
  timeouts.
- Replace query-time embedding counts with an existence probe.
- Remove the duplicate source raw count and constrain the embedding count to
  the active mapping/model.
- Add `/ready` with worker-heartbeat and pool-pressure checks.
- Add a btree index for `(embedding_model, mapping_version)`.

## Drain acceleration

- Extended `embeddings.generate` expiry from the pg-boss 15-minute default to
  two hours, with three retries and exponential backoff. Extended
  `source.index` expiry to four hours.
- Updated all 207 existing embedding jobs to the two-hour expiry and recovered
  the orphaned active job to `retry` while ingestion was paused.
- Deferred stale-version deletion to a singleton `embeddings.purge_stale` job
  that only runs after the source/version backlog reaches zero.
- Consolidated each 500-record job into one bulk upsert and made provider/job
  concurrency bounded by validated environment variables.
- Reused one worker database pool and the already-started pg-boss instance,
  removing per-handler pool spikes and the worker's second pg-boss pool.
- Added OpenRouter `Retry-After` handling and structured per-stage timing.
- Added operational metrics for pending records, oldest job, 15/60-minute
  throughput, and job duration p50/p95.

Production rollout:

- Worker `18c7b073-3199-41e6-84ec-8aad83d98b72` deployed with ingestion paused
  while HNSW maintenance completed. Effective queue settings were verified in
  `pgboss.queue`: 7200 seconds for embeddings, 14400 seconds for source
  indexing, and 600 seconds for stale purge retries.
- API `ec54371d-8145-472a-9221-0c3bea6c8e6c` deployed with throughput metrics;
  `/ready` remained HTTP 200 with `waiting=0`.
- Worker `4919b7e3-d1d1-4755-b188-9975d2ef0225` resumed ingestion with one
  embedding-job writer and two bounded provider requests.

## Recovery

1. Fast database reboot cleared the 25h autovacuum.
2. Supabase compute was temporarily increased from Micro to Large. The
   interrupted concurrent build left the original HNSW valid and a 691 MB
   invalid `_ccnew` index, which was removed before retrying.
3. `REINDEX INDEX CONCURRENTLY record_embeddings_embedding_hnsw_idx` completed
   through a direct session-pooler connection in 104 seconds with
   `maintenance_work_mem=3GB`. The HNSW shrank from 1596 MB to 975 MB.
4. Btree `record_embeddings_model_version_idx` was already applied as
   `add_record_embeddings_model_version_index`.
5. `VACUUM (ANALYZE) record_embeddings` completed in the same session and
   reduced dead tuples from ~40.7% to 0%. The table override was reset, and a
   later automatic vacuum/analyze confirmed autovacuum remained operational.
6. The bounded worker drained the remaining 101,919 queued record IDs in under
   90 minutes at approximately 104k-124k records/hour, with no lock or I/O
   waiters observed.
7. Final reconciliation found 5,356 active-version records missing embeddings:
   4,500 belonged to nine pre-fix jobs archived after provider timeout/circuit
   failures, and 852 were an older unqueued backfill. Twelve idempotent
   missing-only jobs and two deferred purges completed successfully.

## Profile-only sync safety

- Arysa sync job `42220ed4-6403-4a3c-bcf3-8b7ced06d4ea` remained queued behind
  a long-running Tractodiesel full sync and was cancelled before it started.
  No raw records, profile, mapping, indexed records, or embeddings changed.
- `POST /sources/:id/sync` now accepts `indexAfterSync: false`. This mode
  refreshes raw records and the source profile while preserving active indexed
  records and skipping automatic reindexing. Existing clients retain
  `indexAfterSync: true` by default.
- Singleton collisions now return `409` instead of reporting a null job as
  queued, because an existing job may have different indexing semantics.

Production verification on 2026-09-01:

- PR #7 merged to `main` as `02a11ca`.
- API deployment `54f5fcc7-98d5-4a74-9325-e664d4b578a9` and final clean worker
  deployment `e79ff72b-10c8-4012-9823-fc89fb190ba3` succeeded.
- Arysa profile-only sync `e10a50f1-a754-44f4-b9da-52928f10821e` completed,
  followed only by profile job `8b78378a-1f62-4106-a0bd-1aa6e6809a79`.
  No source-index job was created.
- The Arysa product profile changed from 15 to 18 columns, adding
  `company_name`, `product_group`, and `sat_category`. Active mapping version 2,
  4,701 indexed records, and 4,701 embeddings remained intact.

## Verification

- Local: `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- Final active-mapping coverage: 127,753/127,753 records (100%), with zero
  embedding, source-index, or stale-purge jobs pending, active, retrying, or
  failed.
- Final `/health`: `status=ok`, `db=connected`. Final `/ready`:
  `status=ready`, `db=connected`, `worker=ready`, `waiting=0`.
- HNSW is valid and ready. The final purge left 3.4% dead tuples, no lock
  waiters, and autovacuum enabled; this is normal steady-state cleanup.
- Last query-path 504 was `2026-09-01T06:38:52Z` during the blocking REINDEX.

## Deterministic identifier retrieval

Production follow-up on 2026-09-01:

- PR #9 restored green integration CI by serializing shared database suites,
  aligning stale fixtures, restoring read-only foreign-key discovery, and
  ensuring pg-boss v10 queues exist before API-side sends.
- PR #8 added mapping-driven lookup for explicitly labelled product codes and
  short code-only queries. Exact normalized identifier matches now precede
  lexical/vector RRF results without treating unlabelled years, prices, or
  measurements as identifiers.
- GitHub CI passed all 254 tests for merge commit `7cceb2e`.
- Railway API deployment `6ab05585-a3ef-4f5e-90e4-be9ced67af87` and worker
  deployment `e66eb62f-d684-407c-8def-6ce2e418d488` succeeded.
- `https://data.whaapy.com/health` returned `status=ok`, `db=connected`; API
  startup and worker heartbeat logs contained no errors.

Rollback: redeploy the previous successful API and worker releases. No schema
migration or reindex is required for either rollout or rollback.

## Residual

- Keep one embedding-job writer and two provider requests until normal ingest
  is observed for 24 hours; scale only if pending records grow continuously.
- Keep Large during that observation window. Medium is the first downgrade
  candidate; Micro is not suitable for the current ~1.7 GB HNSW working set.
- Alert on active-version embedding coverage below 100%, not only pg-boss
  backlog, because archived terminal jobs are absent from the live queue.

## Rollback

- API/worker: redeploy the previous successful deployment.
- Ingestion: keep `WORKER_INGESTION_PAUSED=true` to prevent additional writes.
- Database: concurrent index operations preserve the previous index until the
  replacement completes; do not drop the current HNSW during recovery.
