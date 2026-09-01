import type PgBoss from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDINGS_GENERATE_JOB, type Database } from '@data-gateway/core';
import { workerEnvSchema } from '../env.js';
import { registerIndexingJobs } from './indexing.js';

describe('embedding worker registration', () => {
  it('registers one single-job worker per configured concurrency slot', () => {
    const work = vi.fn(
      async (_name: string, _options?: PgBoss.WorkOptions, _handler?: PgBoss.WorkHandler<object>) =>
        crypto.randomUUID(),
    );
    const boss = { work } as unknown as PgBoss;
    const env = workerEnvSchema.parse({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/data_gateway',
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      NODE_ENV: 'test',
      USE_MOCK_PROVIDERS: 'true',
      EMBEDDING_JOB_CONCURRENCY: '3',
      INGEST_DATABASE_POOL_MAX: '3',
    });

    registerIndexingJobs(boss, env, {} as Database);

    const registrations = work.mock.calls.filter(([name]) => name === EMBEDDINGS_GENERATE_JOB);
    expect(registrations).toHaveLength(3);
    for (const [, options] of registrations) {
      expect(options).toMatchObject({ batchSize: 1 });
    }
  });
});
