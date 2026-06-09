import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sourceRecordsRaw, sources } from '../db/schema/index.js';
import { createDatabaseConnector } from '../connectors/factory.js';
import { GatewayError } from '../errors/gateway-error.js';
import { payloadHash } from '../utils/hash.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_PROFILE_JOB } from '../queue/jobs.js';
import { getDecryptedSourceConfig, updateSourceConfig } from './sources.js';
import type { TableSchema } from '../connectors/types.js';
import { toScalarString } from '../utils/scalar.js';

type SyncState = Record<
  string,
  {
    cursorColumn?: string;
    cursorValue?: string;
    cursorTieBreakerColumn?: string;
    cursorTieBreakerValue?: string;
  }
>;

export async function syncDatabaseSource(
  db: Database,
  sourceId: string,
  workspaceId: string,
  encryptionKey: string,
  connectionString: string,
  options: { fullSync?: boolean } = {},
): Promise<{ synced: number; tables: string[] }> {
  const [source] = await db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);

  if (!source) {
    throw GatewayError.notFound('Source not found');
  }
  if (source.type !== 'database_url') {
    throw GatewayError.validation('Sync is only supported for database_url sources');
  }

  const config = getDecryptedSourceConfig(source, encryptionKey);
  const connectionUrl =
    typeof config.connectionUrl === 'string' ? config.connectionUrl : '';
  const configuredTables = Array.isArray(config.tables) ? (config.tables as string[]) : undefined;
  const syncState = (config.syncState as SyncState | undefined) ?? {};

  const connector = createDatabaseConnector(connectionUrl);
  let synced = 0;

  try {
    const schema = await connector.introspectSchema();
    const tables = selectTables(schema, configuredTables);

    for (const table of tables) {
      if (table.primaryKey.length === 0) continue;

      const tableKey = `${table.schema}.${table.name}`;
      const cursorColumn = table.cursorColumn;
      const cursorTieBreakerColumn = cursorColumn ? table.primaryKey[0] : undefined;
      const cursorState = !options.fullSync && cursorColumn ? syncState[tableKey] : undefined;
      const orderBy = cursorColumn
        ? [cursorColumn, ...(cursorTieBreakerColumn ? [cursorTieBreakerColumn] : [])]
        : table.primaryKey;
      const streamOptions = {
        batchSize: 200,
        orderBy,
        ...(!options.fullSync && cursorColumn
          ? {
              cursorColumn,
              ...(cursorTieBreakerColumn ? { cursorTieBreakerColumn } : {}),
              ...(cursorState?.cursorValue ? { cursorValue: cursorState.cursorValue } : {}),
              ...(cursorState?.cursorTieBreakerValue
                ? { cursorTieBreakerValue: cursorState.cursorTieBreakerValue }
                : {}),
            }
          : {}),
      };

      for await (const batch of connector.streamRows(tableKey, streamOptions)) {
        for (const row of batch) {
          const payload = { ...row, __table: table.name };
          const hash = payloadHash(payload);
          const externalId = table.primaryKey.map((key) => toScalarString(row[key])).join(':');
          const sourceRecordId = `${table.name}:${externalId}`;

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

          synced += 1;
        }

        if (cursorColumn && batch.length > 0) {
          const lastRow = batch[batch.length - 1];
          const value = lastRow?.[cursorColumn];
          if (value !== undefined && value !== null) {
            const tieBreakerValue =
              cursorTieBreakerColumn === undefined ? undefined : lastRow?.[cursorTieBreakerColumn];
            const tieBreakerString =
              tieBreakerValue === undefined || tieBreakerValue === null
                ? undefined
                : toScalarString(tieBreakerValue);
            syncState[tableKey] = {
              cursorColumn,
              cursorValue: toScalarString(value),
              ...(cursorTieBreakerColumn && tieBreakerString
                ? {
                    cursorTieBreakerColumn,
                    cursorTieBreakerValue: tieBreakerString,
                  }
                : {}),
            };
          }
        }
      }
    }

    await updateSourceConfig(db, sourceId, workspaceId, { syncState }, encryptionKey);

    await db
      .update(sources)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(sources.id, sourceId));

    await enqueueJob(connectionString, SOURCE_PROFILE_JOB, { sourceId, workspaceId });

    return { synced, tables: tables.map((table) => `${table.schema}.${table.name}`) };
  } finally {
    await connector.close();
  }
}

function selectTables(schema: TableSchema[], configuredTables?: string[]): TableSchema[] {
  if (!configuredTables || configuredTables.length === 0) {
    return schema.filter((table) => table.primaryKey.length > 0);
  }

  const selected = new Set(configuredTables);
  return schema.filter((table) => {
    const qualified = `${table.schema}.${table.name}`;
    return selected.has(table.name) || selected.has(qualified);
  });
}
