import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_SYNC_JOB } from '../queue/jobs.js';

export async function enqueueShopifyIncrementalSyncs(
  db: Database,
  connectionString: string,
): Promise<number> {
  const shopifySources = await db
    .select({ id: sources.id, workspaceId: sources.workspaceId })
    .from(sources)
    .where(eq(sources.type, 'shopify'));

  for (const source of shopifySources) {
    await enqueueJob(
      connectionString,
      SOURCE_SYNC_JOB,
      {
        sourceId: source.id,
        workspaceId: source.workspaceId,
        fullSync: false,
      },
      { singletonKey: `source-sync:${source.id}` },
    );
  }

  return shopifySources.length;
}
