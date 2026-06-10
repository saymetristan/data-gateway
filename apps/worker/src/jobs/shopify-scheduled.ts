import type PgBoss from 'pg-boss';
import {
  createDbFromPool,
  createPool,
  enqueueShopifyIncrementalSyncs,
  SHOPIFY_SYNC_SCHEDULED_JOB,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerShopifyScheduledJobs(boss: PgBoss, env: WorkerEnv): void {
  void boss.work(SHOPIFY_SYNC_SCHEDULED_JOB, async () => {
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);

    try {
      await enqueueShopifyIncrementalSyncs(db, env.DATABASE_URL);
    } finally {
      await pool.end();
    }
  });
}

export async function scheduleShopifySyncJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(SHOPIFY_SYNC_SCHEDULED_JOB, '0 */6 * * *', {}, { tz: 'UTC' });
}
