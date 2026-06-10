import PgBoss from 'pg-boss';

let bossInstance: PgBoss | null = null;

export async function getQueue(connectionString: string): Promise<PgBoss> {
  if (!bossInstance) {
    bossInstance = new PgBoss({
      connectionString,
      schema: 'pgboss',
    });
    await bossInstance.start();
  }
  return bossInstance;
}

export async function enqueueJob(
  connectionString: string,
  jobName: string,
  data: Record<string, unknown>,
  options: PgBoss.SendOptions = {},
): Promise<string | null> {
  const boss = await getQueue(connectionString);
  return boss.send(jobName, data, options);
}

export async function closeQueue(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, timeout: 10_000 });
    bossInstance = null;
  }
}
