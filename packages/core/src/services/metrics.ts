import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { OperationalMetrics } from '../schemas/metrics.js';

const DEFAULT_WINDOW_HOURS = 24;

export async function getOperationalMetrics(
  db: Database,
  windowHours = DEFAULT_WINDOW_HOURS,
): Promise<OperationalMetrics> {
  const queryStats = await db.execute<{
    total: string;
    errors: string;
    p50: string | null;
    p95: string | null;
  }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE error IS NOT NULL)::text AS errors,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::text AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::text AS p95
    FROM query_logs
    WHERE created_at >= now() - (${windowHours}::text || ' hours')::interval
  `);

  const queryRow = queryStats.rows[0];

  let queueRows: Array<{ name: string; state: string; count: string }> = [];
  let embeddingIngestion = {
    pendingJobs: 0,
    activeJobs: 0,
    retryJobs: 0,
    pendingRecords: 0,
    oldestPendingAt: null as string | null,
    completedRecords15m: 0,
    completedRecords60m: 0,
    jobDurationMsP50: null as number | null,
    jobDurationMsP95: null as number | null,
  };
  try {
    const queueStats = await db.execute<{ name: string; state: string; count: string }>(sql`
      SELECT name, state, COUNT(*)::text AS count
      FROM pgboss.job
      GROUP BY name, state
      ORDER BY name, state
    `);
    queueRows = queueStats.rows;

    const embeddingStats = await db.execute<{
      pending_jobs: string;
      active_jobs: string;
      retry_jobs: string;
      pending_records: string;
      oldest_pending_at: string | null;
      completed_records_15m: string;
      completed_records_60m: string;
      duration_ms_p50: string | null;
      duration_ms_p95: string | null;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE state = 'created')::text AS pending_jobs,
        COUNT(*) FILTER (WHERE state = 'active')::text AS active_jobs,
        COUNT(*) FILTER (WHERE state = 'retry')::text AS retry_jobs,
        COALESCE(
          SUM(jsonb_array_length(data->'recordIds'))
            FILTER (WHERE state IN ('created', 'active', 'retry')),
          0
        )::text AS pending_records,
        (
          MIN(created_on) FILTER (WHERE state IN ('created', 'active', 'retry'))
        )::text AS oldest_pending_at,
        COALESCE(
          SUM(jsonb_array_length(data->'recordIds'))
            FILTER (WHERE state = 'completed' AND completed_on >= now() - interval '15 minutes'),
          0
        )::text AS completed_records_15m,
        COALESCE(
          SUM(jsonb_array_length(data->'recordIds'))
            FILTER (WHERE state = 'completed' AND completed_on >= now() - interval '60 minutes'),
          0
        )::text AS completed_records_60m,
        (
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (completed_on - started_on)) * 1000
          ) FILTER (
            WHERE state = 'completed' AND completed_on >= now() - interval '60 minutes'
          )
        )::text AS duration_ms_p50,
        (
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY extract(epoch FROM (completed_on - started_on)) * 1000
          ) FILTER (
            WHERE state = 'completed' AND completed_on >= now() - interval '60 minutes'
          )
        )::text AS duration_ms_p95
      FROM pgboss.job
      WHERE name = 'embeddings.generate'
    `);
    const row = embeddingStats.rows[0];
    embeddingIngestion = {
      pendingJobs: Number(row?.pending_jobs ?? 0),
      activeJobs: Number(row?.active_jobs ?? 0),
      retryJobs: Number(row?.retry_jobs ?? 0),
      pendingRecords: Number(row?.pending_records ?? 0),
      oldestPendingAt: row?.oldest_pending_at ?? null,
      completedRecords15m: Number(row?.completed_records_15m ?? 0),
      completedRecords60m: Number(row?.completed_records_60m ?? 0),
      jobDurationMsP50: row?.duration_ms_p50 ? Number(row.duration_ms_p50) : null,
      jobDurationMsP95: row?.duration_ms_p95 ? Number(row.duration_ms_p95) : null,
    };
  } catch {
    queueRows = [];
  }

  const webhookStats = await db.execute<{ status: string; count: string }>(sql`
    SELECT status, COUNT(*)::text AS count
    FROM webhook_events
    GROUP BY status
    ORDER BY status
  `);

  const maturityStats = await db.execute<{ maturity_status: string; count: string }>(sql`
    SELECT maturity_status, COUNT(*)::text AS count
    FROM sources
    GROUP BY maturity_status
    ORDER BY maturity_status
  `);

  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    query: {
      total: Number(queryRow?.total ?? 0),
      errors: Number(queryRow?.errors ?? 0),
      latencyMsP50: queryRow?.p50 ? Number(queryRow.p50) : null,
      latencyMsP95: queryRow?.p95 ? Number(queryRow.p95) : null,
    },
    queues: queueRows.map((row) => ({
      name: row.name,
      state: row.state,
      count: Number(row.count),
    })),
    embeddingIngestion,
    sync: {
      webhookEvents: webhookStats.rows.map((row) => ({
        status: row.status,
        count: Number(row.count),
      })),
      sourcesByMaturity: maturityStats.rows.map((row) => ({
        maturityStatus: row.maturity_status,
        count: Number(row.count),
      })),
    },
  };
}
