import PgBoss from 'pg-boss';
import { ALL_JOB_QUEUES } from '@data-gateway/core';
import { loadWorkerEnv } from './env.js';
import { registerJobs, scheduleJobs } from './jobs/index.js';

const env = loadWorkerEnv();

const boss = new PgBoss({
  connectionString: env.DATABASE_URL,
  schema: 'pgboss',
});

let shuttingDown = false;

async function start(): Promise<void> {
  boss.on('error', (error) => {
    console.error('pg-boss error:', error);
  });

  await boss.start();
  for (const queue of ALL_JOB_QUEUES) {
    await boss.createQueue(queue);
  }
  registerJobs(boss, env);
  await scheduleJobs(boss);
  console.log('Worker started (pg-boss schema: pgboss)');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down worker...`);
  await boss.stop({ graceful: true, timeout: 10_000 });
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
