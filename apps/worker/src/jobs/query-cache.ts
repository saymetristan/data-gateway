import type PgBoss from 'pg-boss';
import {
  QUERY_EMBEDDING_CACHE_PURGE_JOB,
  type Database,
  purgeExpiredQueryEmbeddingCache,
} from '@data-gateway/core';

export function registerQueryCacheJobs(boss: PgBoss, db: Database): void {
  void boss.work(QUERY_EMBEDDING_CACHE_PURGE_JOB, async () => {
    const deleted = await purgeExpiredQueryEmbeddingCache(db);
    console.log(`[${QUERY_EMBEDDING_CACHE_PURGE_JOB}] purged ${String(deleted)} rows`);
  });
}

export async function scheduleQueryCacheJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(QUERY_EMBEDDING_CACHE_PURGE_JOB, '0 */6 * * *', {}, { tz: 'UTC' });
}
