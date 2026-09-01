import { describe, expect, it } from 'vitest';
import { loadWorkerEnv, workerEnvSchema } from './env.js';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/data_gateway',
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('worker env', () => {
  it('uses ingest-safe timeouts by default', () => {
    const env = loadWorkerEnv(BASE_ENV);

    expect(env.INGEST_EMBEDDING_HARD_TIMEOUT_MS).toBe(60_000);
    expect(env.INGEST_EMBEDDING_MAX_RETRIES).toBe(2);
    expect(env.INGEST_DATABASE_CONNECTION_TIMEOUT_MS).toBe(30_000);
    expect(env.INGEST_DATABASE_STATEMENT_TIMEOUT_MS).toBe(300_000);
    expect(env.EMBEDDING_JOB_CONCURRENCY).toBe(1);
    expect(env.EMBEDDING_PROVIDER_CONCURRENCY).toBe(2);
    expect(env.INGEST_DATABASE_POOL_MAX).toBe(1);
    expect(env.WORKER_PGBOSS_POOL_MAX).toBe(3);
  });

  it('rejects embedding concurrency above the database pool', () => {
    const parsed = workerEnvSchema.safeParse({
      ...BASE_ENV,
      EMBEDDING_JOB_CONCURRENCY: '3',
      INGEST_DATABASE_POOL_MAX: '2',
    });

    expect(parsed.success).toBe(false);
  });

  it('parses the ingestion pause switch', () => {
    const env = loadWorkerEnv({
      ...BASE_ENV,
      WORKER_INGESTION_PAUSED: 'true',
    });

    expect(env.WORKER_INGESTION_PAUSED).toBe(true);
  });
});
