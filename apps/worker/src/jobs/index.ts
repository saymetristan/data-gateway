import type PgBoss from 'pg-boss';
import type { WorkerEnv } from '../env.js';
import { registerJobs as registerHealthJobs, scheduleJobs as scheduleHealthJobs } from './health.js';
import { registerSyncJobs } from './sync.js';
import { registerProfileJobs } from './profile.js';
import { registerIndexingJobs } from './indexing.js';
import { registerEvalJobs } from './evals.js';
import { registerShopifyWebhookJobs } from './shopify-webhooks.js';
import {
  registerShopifyScheduledJobs,
  scheduleShopifySyncJobs,
} from './shopify-scheduled.js';
import {
  registerQueryCacheJobs,
  scheduleQueryCacheJobs,
} from './query-cache.js';

export function registerJobs(boss: PgBoss, env: WorkerEnv): void {
  registerHealthJobs(boss);
  registerSyncJobs(boss, env);
  registerProfileJobs(boss, env);
  registerIndexingJobs(boss, env);
  registerEvalJobs(boss, env);
  registerShopifyWebhookJobs(boss, env);
  registerShopifyScheduledJobs(boss, env);
  registerQueryCacheJobs(boss, env);
}

export async function scheduleJobs(boss: PgBoss): Promise<void> {
  await scheduleHealthJobs(boss);
  await scheduleShopifySyncJobs(boss);
  await scheduleQueryCacheJobs(boss);
}
