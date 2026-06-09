import type PgBoss from 'pg-boss';
import {
  createDbFromPool,
  createPool,
  profileSource,
  SOURCE_PROFILE_JOB,
  type SourceProfileJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerProfileJobs(boss: PgBoss, env: WorkerEnv): void {
  void boss.work(SOURCE_PROFILE_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as SourceProfileJobData;
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);
    try {
      await profileSource(db, data.sourceId);
    } finally {
      await pool.end();
    }
  });
}
