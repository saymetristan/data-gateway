import type PgBoss from 'pg-boss';
import { createDb, profileSource, SOURCE_PROFILE_JOB, type SourceProfileJobData } from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerProfileJobs(boss: PgBoss, env: WorkerEnv): void {
  void boss.work(SOURCE_PROFILE_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as SourceProfileJobData;
    const db = createDb(env.DATABASE_URL);
    await profileSource(db, data.sourceId);
  });
}
