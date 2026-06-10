import { and, eq } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import type { Database } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_PROFILE_JOB } from '../queue/jobs.js';
import { payloadHash } from '../utils/hash.js';
import { removeStaleRawRecords, upsertRawRecord } from './raw-records.js';

export async function ingestCsvUpload(
  db: Database,
  sourceId: string,
  workspaceId: string,
  csvContent: string,
  connectionString: string,
): Promise<{ imported: number }> {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);
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
  const seenRecordIds = new Set<string>();

  for (const row of rows) {
    const payload = { ...row, __table: 'csv' };
    const primaryKey = row.id ?? buildCsvFallbackPrimaryKey(row);
    const sourceRecordId = `csv:${primaryKey}`;
    seenRecordIds.add(sourceRecordId);

    if (await upsertRawRecord(db, sourceId, sourceRecordId, payload)) {
      imported += 1;
    }
  }

  await removeStaleRawRecords(db, sourceId, seenRecordIds);

  await db
    .update(sources)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(sources.id, sourceId));

  await enqueueJob(connectionString, SOURCE_PROFILE_JOB, { sourceId, workspaceId });

  return { imported };
}

export function buildCsvFallbackPrimaryKey(row: Record<string, string>): string {
  const sku = row.sku ?? row.SKU;
  const hash = payloadHash(row).slice(0, 16);
  return sku ? `${sku}:${hash}` : `row:${hash}`;
}
