import type PgBoss from 'pg-boss';
import type { WorkerEnv } from '../env.js';
import { registerJobs as registerHealthJobs, scheduleJobs as scheduleHealthJobs } from './health.js';
import { registerSyncJobs } from './sync.js';
import { registerProfileJobs } from './profile.js';
import { registerIndexingJobs } from './indexing.js';

export function registerJobs(boss: PgBoss, env: WorkerEnv): void {
  registerHealthJobs(boss);
  registerSyncJobs(boss, env);
  registerProfileJobs(boss, env);
  registerIndexingJobs(boss, env);
}

export async function scheduleJobs(boss: PgBoss): Promise<void> {
  await scheduleHealthJobs(boss);
}
