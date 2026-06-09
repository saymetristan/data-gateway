import type PgBoss from 'pg-boss';
import { createDb, syncDatabaseSource, SOURCE_SYNC_JOB, type SourceSyncJobData } from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';

export function registerSyncJobs(boss: PgBoss, env: WorkerEnv): void {
  void boss.work(SOURCE_SYNC_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as SourceSyncJobData;
    const db = createDb(env.DATABASE_URL);

    await syncDatabaseSource(
      db,
      data.sourceId,
      data.workspaceId,
      env.CREDENTIALS_ENCRYPTION_KEY,
      env.DATABASE_URL,
      { fullSync: data.fullSync ?? false },
    );
  });
}
