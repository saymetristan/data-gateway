import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { records, sourceRecordsRaw } from '../db/schema/index.js';
import { payloadHash } from '../utils/hash.js';

export async function upsertRawRecord(
  db: Database,
  sourceId: string,
  sourceRecordId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const hash = payloadHash(payload);
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
    return false;
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

  return true;
}

export async function deleteRawRecords(
  db: Database,
  sourceId: string,
  sourceRecordIds: string[],
): Promise<void> {
  if (sourceRecordIds.length === 0) return;

  for (const sourceRecordId of sourceRecordIds) {
    await db
      .delete(sourceRecordsRaw)
      .where(
        and(
          eq(sourceRecordsRaw.sourceId, sourceId),
          eq(sourceRecordsRaw.sourceRecordId, sourceRecordId),
        ),
      );
  }

  const externalIds = sourceRecordIds.map((id) => externalIdFromSourceRecordId(id));
  const existingRecords = await db
    .select({ id: records.id, externalId: records.externalId })
    .from(records)
    .where(eq(records.sourceId, sourceId));

  for (const record of existingRecords) {
    if (externalIds.includes(record.externalId)) {
      await db.delete(records).where(eq(records.id, record.id));
    }
  }
}

export async function removeStaleRawRecords(
  db: Database,
  sourceId: string,
  seenRecordIds: Set<string>,
): Promise<void> {
  const rawRows = await db
    .select({ id: sourceRecordsRaw.id, sourceRecordId: sourceRecordsRaw.sourceRecordId })
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId));

  const liveExternalIds = new Set<string>();
  for (const row of rawRows) {
    if (!seenRecordIds.has(row.sourceRecordId)) {
      await db.delete(sourceRecordsRaw).where(eq(sourceRecordsRaw.id, row.id));
      continue;
    }
    liveExternalIds.add(externalIdFromSourceRecordId(row.sourceRecordId));
  }

  const existingRecords = await db
    .select({ id: records.id, externalId: records.externalId })
    .from(records)
    .where(eq(records.sourceId, sourceId));

  for (const record of existingRecords) {
    if (!liveExternalIds.has(record.externalId)) {
      await db.delete(records).where(eq(records.id, record.id));
    }
  }
}

function externalIdFromSourceRecordId(sourceRecordId: string): string {
  const separator = sourceRecordId.indexOf(':');
  return separator === -1 ? sourceRecordId : sourceRecordId.slice(separator + 1);
}
