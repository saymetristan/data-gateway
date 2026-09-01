import type PgBoss from 'pg-boss';
import {
  type Database,
  indexSource,
  generateEmbeddingsForRecords,
  findPendingEmbeddingBackfills,
  purgeStaleEmbeddingsForSourceVersion,
  SOURCE_INDEX_JOB,
  EMBEDDINGS_GENERATE_JOB,
  EMBEDDINGS_PURGE_STALE_JOB,
  type SourceIndexJobData,
  type EmbeddingsGenerateJobData,
  type EmbeddingsPurgeStaleJobData,
} from '@data-gateway/core';
import type { WorkerEnv } from '../env.js';
import { createEmbeddingProvider, createLlmProvider } from '../providers.js';

export function registerIndexingJobs(boss: PgBoss, env: WorkerEnv, db: Database): void {
  const llmProvider = createLlmProvider(env);
  const embeddingProvider = createEmbeddingProvider(env);

  void boss.work(SOURCE_INDEX_JOB, async (jobs) => {
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return;

    const data = job.data as SourceIndexJobData;
    await indexSource(db, data.sourceId, data.workspaceId, env.DATABASE_URL, llmProvider, {
      invalidateMaturity: data.invalidateMaturity ?? true,
      embeddingModel: embeddingProvider.model,
    });
  });

  for (let worker = 0; worker < env.EMBEDDING_JOB_CONCURRENCY; worker += 1) {
    void boss.work(EMBEDDINGS_GENERATE_JOB, { batchSize: 1 }, async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      const data = job.data as EmbeddingsGenerateJobData;
      const written = await generateEmbeddingsForRecords(
        db,
        data.sourceId,
        data.recordIds,
        data.mappingVersion,
        embeddingProvider,
        {
          providerConcurrency: env.EMBEDDING_PROVIDER_CONCURRENCY,
          onTiming: (timing) => {
            console.log(
              JSON.stringify({
                event: 'embedding_job_timing',
                jobId: job.id,
                sourceId: data.sourceId,
                ...timing,
              }),
            );
          },
        },
      );
      console.log(
        JSON.stringify({
          event: 'embedding_job_completed',
          jobId: job.id,
          sourceId: data.sourceId,
          records: data.recordIds.length,
          written,
        }),
      );
    });
  }

  void boss.work(EMBEDDINGS_PURGE_STALE_JOB, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    const data = job.data as EmbeddingsPurgeStaleJobData;
    const result = await purgeStaleEmbeddingsForSourceVersion(db, data);
    if (result.pending) {
      throw new Error(
        `Embedding backlog still active for ${data.sourceId} v${String(data.mappingVersion)}`,
      );
    }
    console.log(
      JSON.stringify({
        event: 'embedding_stale_purge_completed',
        jobId: job.id,
        sourceId: data.sourceId,
        mappingVersion: data.mappingVersion,
        deleted: result.deleted,
      }),
    );
  });
}

export async function enqueuePendingEmbeddingPurges(
  boss: PgBoss,
  env: WorkerEnv,
  db: Database,
): Promise<void> {
  const backfills = await findPendingEmbeddingBackfills(db, env.EMBEDDING_MODEL);
  for (const data of backfills) {
    await boss.send(EMBEDDINGS_PURGE_STALE_JOB, data, {
      singletonKey: `embeddings-purge:${data.sourceId}:${String(data.mappingVersion)}:${data.embeddingModel}`,
      singletonMinutes: 60,
    });
  }
}
