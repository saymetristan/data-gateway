import type PgBoss from 'pg-boss';
import {
  createDbFromPool,
  createPool,
  runEvalSet,
  EVALS_RUN_JOB,
  type EvalsRunJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';
import { createEmbeddingProvider, createLlmProvider } from '../providers.js';

export function registerEvalJobs(boss: PgBoss, env: WorkerEnv): void {
  const embeddingProvider = createEmbeddingProvider(env);
  const llmProvider = createLlmProvider(env);

  void boss.work(EVALS_RUN_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as EvalsRunJobData;
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);
    try {
      await runEvalSet(db, data.evalRunId, data.workspaceId, embeddingProvider, llmProvider);
    } finally {
      await pool.end();
    }
  });
}
