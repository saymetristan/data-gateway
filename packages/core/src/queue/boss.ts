import PgBoss from 'pg-boss';

let bossInstance: PgBoss | null = null;

/** Keep completed jobs briefly, then drop archive rows aggressively (archive was 547MB). */
const PGBOSS_ARCHIVE_COMPLETED_AFTER_SECONDS = 3_600;
const PGBOSS_DELETE_AFTER_DAYS = 2;

export async function getQueue(connectionString: string): Promise<PgBoss> {
  if (!bossInstance) {
    bossInstance = new PgBoss({
      connectionString,
      schema: 'pgboss',
      // Solo encola jobs desde la API; pool mínimo para no agotar el session pooler.
      max: 2,
      archiveCompletedAfterSeconds: PGBOSS_ARCHIVE_COMPLETED_AFTER_SECONDS,
      deleteAfterDays: PGBOSS_DELETE_AFTER_DAYS,
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
