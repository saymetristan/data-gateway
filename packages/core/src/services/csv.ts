import { and, eq } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import type { Database } from '../db/client.js';
import { sourceRecordsRaw, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import { payloadHash } from '../utils/hash.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_PROFILE_JOB } from '../queue/jobs.js';

export async function ingestCsvUpload(
  db: Database,
  sourceId: string,
  workspaceId: string,
  csvContent: string,
  connectionString: string,
): Promise<{ imported: number }> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }
  if (source.type !== 'csv') {
    throw GatewayError.validation('CSV upload is only supported for csv sources');
  }

  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  let imported = 0;
  let rowNumber = 1;

  for (const row of rows) {
    const payload = { ...row, __table: 'csv' };
    const hash = payloadHash(payload);
    const primaryKey = row.id ?? row.sku ?? row.SKU ?? String(rowNumber);
    const sourceRecordId = `csv:${primaryKey}`;

    const [existing] = await db
      .select({ payloadHash: sourceRecordsRaw.payloadHash })
      .from(sourceRecordsRaw)
      .where(
        and(
          eq(sourceRecordsRaw.sourceId, sourceId),
          eq(sourceRecordsRaw.sourceRecordId, sourceRecordId),
        ),
      )
      .limit(1);

    if (existing?.payloadHash === hash) {
      rowNumber += 1;
      continue;
    }

    await db
      .insert(sourceRecordsRaw)
      .values({
        sourceId,
        sourceRecordId,
        payload,
        payloadHash: hash,
      })
      .onConflictDoUpdate({
        target: [sourceRecordsRaw.sourceId, sourceRecordsRaw.sourceRecordId],
        set: {
          payload,
          payloadHash: hash,
          syncedAt: new Date(),
        },
      });

    imported += 1;
    rowNumber += 1;
  }

  await db
    .update(sources)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(sources.id, sourceId));

  await enqueueJob(connectionString, SOURCE_PROFILE_JOB, { sourceId, workspaceId });

  return { imported };
}
