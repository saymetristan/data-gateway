import type PgBoss from 'pg-boss';
import {
  type Database,
  profileSource,
  SOURCE_PROFILE_JOB,
  type SourceProfileJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerProfileJobs(boss: PgBoss, _env: WorkerEnv, db: Database): void {
  void boss.work(SOURCE_PROFILE_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as SourceProfileJobData;
    await profileSource(db, data.sourceId, data.workspaceId);
  });
}
