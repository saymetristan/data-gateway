import type PgBoss from 'pg-boss';

export const HEALTH_HEARTBEAT_JOB = 'health.heartbeat';

export function registerJobs(boss: PgBoss): void {
  void boss.work(HEALTH_HEARTBEAT_JOB, async () => {
    console.log(`[${HEALTH_HEARTBEAT_JOB}] ok ${new Date().toISOString()}`);
    await Promise.resolve();
  });
}

export async function scheduleJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(HEALTH_HEARTBEAT_JOB, '*/1 * * * *', {}, { tz: 'UTC' });
}
