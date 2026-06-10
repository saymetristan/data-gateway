import type PgBoss from 'pg-boss';
import {
  createDbFromPool,
  createPool,
  processShopifyWebhook,
  SHOPIFY_WEBHOOK_JOB,
  type ShopifyWebhookJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';
import { createShopifyClientForWorker } from '../shopify.js';

export function registerShopifyWebhookJobs(boss: PgBoss, env: WorkerEnv): void {
  void boss.work(SHOPIFY_WEBHOOK_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as ShopifyWebhookJobData;
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);

    try {
      const client = await createShopifyClientForWorker(db, data.sourceId, env);
      await processShopifyWebhook(db, env.DATABASE_URL, client, data);
    } finally {
      await pool.end();
    }
  });
}
