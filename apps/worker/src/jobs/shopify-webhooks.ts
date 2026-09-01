import type PgBoss from 'pg-boss';
import {
  type Database,
  processShopifyWebhook,
  SHOPIFY_WEBHOOK_JOB,
  type ShopifyWebhookJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';
import { createShopifyClientForWorker } from '../shopify.js';

export function registerShopifyWebhookJobs(boss: PgBoss, env: WorkerEnv, db: Database): void {
  void boss.work(SHOPIFY_WEBHOOK_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as ShopifyWebhookJobData;
    const client = await createShopifyClientForWorker(db, data.sourceId, env);
    await processShopifyWebhook(db, env.DATABASE_URL, client, data);
  });
}
