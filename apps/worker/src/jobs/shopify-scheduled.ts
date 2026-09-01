import type PgBoss from 'pg-boss';
import {
  type Database,
  enqueueShopifyIncrementalSyncs,
  SHOPIFY_SYNC_SCHEDULED_JOB,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerShopifyScheduledJobs(boss: PgBoss, env: WorkerEnv, db: Database): void {
  void boss.work(SHOPIFY_SYNC_SCHEDULED_JOB, async () => {
    await enqueueShopifyIncrementalSyncs(db, env.DATABASE_URL);
  });
}

export async function scheduleShopifySyncJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(SHOPIFY_SYNC_SCHEDULED_JOB, '0 */6 * * *', {}, { tz: 'UTC' });
}
