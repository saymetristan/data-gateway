import type PgBoss from 'pg-boss';
import {
  createDb,
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
    const db = createDb(env.DATABASE_URL);
    await indexSource(db, data.sourceId, data.workspaceId, env.DATABASE_URL, llmProvider);
  });

  void boss.work(EMBEDDINGS_GENERATE_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as EmbeddingsGenerateJobData;
    const db = createDb(env.DATABASE_URL);
    await generateEmbeddingsForRecords(
      db,
      data.sourceId,
      data.recordIds,
      data.mappingVersion,
      embeddingProvider,
    );
  });
}
