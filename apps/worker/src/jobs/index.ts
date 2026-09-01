import type PgBoss from 'pg-boss';
import type { Database } from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';
import {
  registerJobs as registerHealthJobs,
  scheduleJobs as scheduleHealthJobs,
} from './health.js';
import { registerSyncJobs } from './sync.js';
import { registerProfileJobs } from './profile.js';
import { enqueuePendingEmbeddingPurges, registerIndexingJobs } from './indexing.js';
import { registerEvalJobs } from './evals.js';
import { registerShopifyWebhookJobs } from './shopify-webhooks.js';
import { registerShopifyScheduledJobs, scheduleShopifySyncJobs } from './shopify-scheduled.js';
import { registerQueryCacheJobs, scheduleQueryCacheJobs } from './query-cache.js';

export function registerJobs(boss: PgBoss, env: WorkerEnv, db: Database): void {
  registerHealthJobs(boss);
  registerQueryCacheJobs(boss, db);
  if (env.WORKER_INGESTION_PAUSED) {
    console.warn('Worker ingestion is paused; source and embedding queues are not registered');
    return;
  }
  registerSyncJobs(boss, env, db);
  registerProfileJobs(boss, env, db);
  registerIndexingJobs(boss, env, db);
  registerEvalJobs(boss, env, db);
  registerShopifyWebhookJobs(boss, env, db);
  registerShopifyScheduledJobs(boss, env, db);
}

export async function scheduleJobs(boss: PgBoss, env: WorkerEnv, db: Database): Promise<void> {
  await scheduleHealthJobs(boss);
  if (!env.WORKER_INGESTION_PAUSED) {
    await scheduleShopifySyncJobs(boss);
    await enqueuePendingEmbeddingPurges(boss, env, db);
  }
  await scheduleQueryCacheJobs(boss);
}
