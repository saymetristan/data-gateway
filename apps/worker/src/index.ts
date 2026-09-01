import PgBoss from 'pg-boss';
import { ALL_JOB_QUEUES, bindQueue, createDbFromPool, createPool } from '@data-gateway/core';
import { loadWorkerEnv } from './env.js';
import { registerJobs, scheduleJobs } from './jobs/index.js';
import { queueOptions } from './queue-config.js';

const env = loadWorkerEnv();

const boss = new PgBoss({
  connectionString: env.DATABASE_URL,
  schema: 'pgboss',
  // Supabase session pooler: 15 total connections across API and worker.
  max: env.WORKER_PGBOSS_POOL_MAX,
  // Archive was ballooning (~547MB); keep history short.
  archiveCompletedAfterSeconds: 3_600,
  deleteAfterDays: 2,
});
const workerPool = createPool(env.DATABASE_URL, {
  max: env.INGEST_DATABASE_POOL_MAX,
  connectionTimeoutMs: env.INGEST_DATABASE_CONNECTION_TIMEOUT_MS,
  statementTimeoutMs: env.INGEST_DATABASE_STATEMENT_TIMEOUT_MS,
});
const db = createDbFromPool(workerPool);

let shuttingDown = false;

async function start(): Promise<void> {
  boss.on('error', (error) => {
    console.error('pg-boss error:', error);
  });

  await boss.start();
  bindQueue(boss);
  for (const queue of ALL_JOB_QUEUES) {
    const options = queueOptions(queue);
    await boss.createQueue(queue, options);
    if (options) {
      await boss.updateQueue(queue, options);
    }
  }
  registerJobs(boss, env, db);
  await scheduleJobs(boss, env, db);
  console.log(
    `Worker started (rollout=drain-v1, pg-boss schema: pgboss, ingestion=${env.WORKER_INGESTION_PAUSED ? 'paused' : 'active'}, embedding-jobs=${String(env.EMBEDDING_JOB_CONCURRENCY)}, provider-concurrency=${String(env.EMBEDDING_PROVIDER_CONCURRENCY)}, db-pool=${String(env.INGEST_DATABASE_POOL_MAX)}, boss-pool=${String(env.WORKER_PGBOSS_POOL_MAX)})`,
  );
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down worker...`);
  await boss.stop({ graceful: true, timeout: 10_000 });
  await workerPool.end();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

start().catch((error: unknown) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
