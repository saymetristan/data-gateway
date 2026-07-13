import type PgBoss from 'pg-boss';
import {
  QUERY_EMBEDDING_CACHE_PURGE_JOB,
  createDbFromPool,
  createPool,
  purgeExpiredQueryEmbeddingCache,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerQueryCacheJobs(boss: PgBoss, env: WorkerEnv): void {
  void boss.work(QUERY_EMBEDDING_CACHE_PURGE_JOB, async () => {
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);
    try {
      const deleted = await purgeExpiredQueryEmbeddingCache(db);
      console.log(`[${QUERY_EMBEDDING_CACHE_PURGE_JOB}] purged ${String(deleted)} rows`);
    } finally {
      await pool.end();
    }
  });
}

export async function scheduleQueryCacheJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(QUERY_EMBEDDING_CACHE_PURGE_JOB, '0 */6 * * *', {}, { tz: 'UTC' });
}
