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
  try {
    const queueStats = await db.execute<{ name: string; state: string; count: string }>(sql`
      SELECT name, state, COUNT(*)::text AS count
      FROM pgboss.job
      GROUP BY name, state
      ORDER BY name, state
    `);
    queueRows = queueStats.rows;
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
