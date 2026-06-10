import type PgBoss from 'pg-boss';
import {
  createDbFromPool,
  createPool,
  indexSource,
  generateEmbeddingsForRecords,
  SOURCE_INDEX_JOB,
  EMBEDDINGS_GENERATE_JOB,
  type SourceIndexJobData,
  type EmbeddingsGenerateJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';
import { createEmbeddingProvider, createLlmProvider } from '../providers.js';

export function registerIndexingJobs(boss: PgBoss, env: WorkerEnv): void {
  const llmProvider = createLlmProvider(env);
  const embeddingProvider = createEmbeddingProvider(env);

  void boss.work(SOURCE_INDEX_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as SourceIndexJobData;
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);
    try {
      await indexSource(db, data.sourceId, data.workspaceId, env.DATABASE_URL, llmProvider, {
        invalidateMaturity: data.invalidateMaturity ?? true,
        embeddingModel: embeddingProvider.model,
      });
    } finally {
      await pool.end();
    }
  });

  void boss.work(EMBEDDINGS_GENERATE_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as EmbeddingsGenerateJobData;
    const pool = createPool(env.DATABASE_URL);
    const db = createDbFromPool(pool);
    try {
      await generateEmbeddingsForRecords(
        db,
        data.sourceId,
        data.recordIds,
        data.mappingVersion,
        embeddingProvider,
      );
    } finally {
      await pool.end();
    }
  });
}
