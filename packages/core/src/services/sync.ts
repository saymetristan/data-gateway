import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mappings, records, sourceRecordsRaw, sources } from '../db/schema/index.js';
import { createDatabaseConnector } from '../connectors/factory.js';
import { GatewayError } from '../errors/gateway-error.js';
import { payloadHash } from '../utils/hash.js';
import { enqueueJob, enqueueSourceIndexJob } from '../queue/boss.js';
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
  options: { fullSync?: boolean; indexAfterSync?: boolean } = {},
): Promise<{ synced: number; tables: string[] }> {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);

  if (!source) {
    throw GatewayError.notFound('Source not found');
  }
  if (source.type !== 'database_url') {
    throw GatewayError.validation('Sync is only supported for database_url sources');
  }

  const config = getDecryptedSourceConfig(source, encryptionKey);
  const connectionUrl = typeof config.connectionUrl === 'string' ? config.connectionUrl : '';
  const configuredTables = Array.isArray(config.tables) ? (config.tables as string[]) : undefined;
  const syncState = (config.syncState as SyncState | undefined) ?? {};

  const connector = createDatabaseConnector(connectionUrl);
  let synced = 0;
  const seenRecordIdsByTable = new Map<string, Set<string>>();

  try {
    const schema = (await connector.introspectSchema()).map((table) => ({
      ...table,
      tableRole: table.tableRole ?? classifyTable(table),
    }));
    const tables = selectTables(schema, configuredTables);

    for (const table of tables) {
      if (table.primaryKey.length === 0) continue;

      const tableKey = `${table.schema}.${table.name}`;
      const businessCursorColumn = table.cursorColumn;
      const primaryCursorColumn = table.primaryKey[0];
      if (!primaryCursorColumn) continue;

      const cursorColumn = businessCursorColumn ?? primaryCursorColumn;
      const cursorTieBreakerColumn =
        businessCursorColumn && businessCursorColumn !== primaryCursorColumn
          ? primaryCursorColumn
          : undefined;
      const persistedState =
        !options.fullSync && businessCursorColumn ? syncState[tableKey] : undefined;
      const cursorState = persistedState?.cursorValue ? persistedState : undefined;
      const orderBy = [cursorColumn, ...(cursorTieBreakerColumn ? [cursorTieBreakerColumn] : [])];
      const streamOptions = {
        batchSize: 200,
        orderBy,
        ...(cursorColumn
          ? {
              cursorColumn,
              ...(cursorTieBreakerColumn && cursorState?.cursorTieBreakerValue
                ? { cursorTieBreakerColumn }
                : {}),
              ...(cursorState?.cursorValue ? { cursorValue: cursorState.cursorValue } : {}),
              ...(cursorState?.cursorTieBreakerValue
                ? { cursorTieBreakerValue: cursorState.cursorTieBreakerValue }
                : {}),
            }
          : {}),
      };

      for await (const batch of connector.streamRows(tableKey, streamOptions)) {
        const seenForTable = seenRecordIdsByTable.get(table.name) ?? new Set<string>();
        seenRecordIdsByTable.set(table.name, seenForTable);
        for (const row of batch) {
          const payload = {
            ...row,
            __table: table.name,
            __schema: table.schema,
            __primaryKey: table.primaryKey,
            __pk: Object.fromEntries(table.primaryKey.map((key) => [key, row[key]])),
            __foreignKeys: table.foreignKeys,
            __tableRole: table.tableRole,
          };
          const hash = payloadHash(payload);
          const externalId = table.primaryKey.map((key) => toScalarString(row[key])).join(':');
          const sourceRecordId = `${table.name}:${externalId}`;
          seenForTable.add(sourceRecordId);

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

        if (businessCursorColumn && batch.length > 0) {
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

    if (options.fullSync) {
      await removeStaleRecords(db, sourceId, seenRecordIdsByTable, options.indexAfterSync ?? true);
    }

    await updateSourceConfig(db, sourceId, workspaceId, { syncState }, encryptionKey);

    await db
      .update(sources)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(sources.id, sourceId));

    await enqueuePostSyncJobs(
      db,
      sourceId,
      workspaceId,
      connectionString,
      options.indexAfterSync ?? true,
    );

    return { synced, tables: tables.map((table) => `${table.schema}.${table.name}`) };
  } finally {
    await connector.close();
  }
}

async function enqueuePostSyncJobs(
  db: Database,
  sourceId: string,
  workspaceId: string,
  connectionString: string,
  indexAfterSync: boolean,
): Promise<void> {
  await enqueueJob(connectionString, SOURCE_PROFILE_JOB, { sourceId, workspaceId });

  if (!indexAfterSync) return;

  const [activeMapping] = await db
    .select({ id: mappings.id })
    .from(mappings)
    .where(and(eq(mappings.sourceId, sourceId), eq(mappings.status, 'active')))
    .orderBy(desc(mappings.version))
    .limit(1);

  if (!activeMapping) return;
  await enqueueSourceIndexJob(connectionString, {
    sourceId,
    workspaceId,
    invalidateMaturity: false,
  });
}

async function removeStaleRecords(
  db: Database,
  sourceId: string,
  seenRecordIdsByTable: Map<string, Set<string>>,
  deleteIndexedRecords: boolean,
): Promise<void> {
  const rawRows = await db
    .select({ id: sourceRecordsRaw.id, sourceRecordId: sourceRecordsRaw.sourceRecordId })
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId));
  const liveExternalIds = new Set<string>();

  for (const row of rawRows) {
    const tableName = row.sourceRecordId.split(':')[0] ?? '';
    const seenForTable = seenRecordIdsByTable.get(tableName);
    if (seenForTable && !seenForTable.has(row.sourceRecordId)) {
      await db.delete(sourceRecordsRaw).where(eq(sourceRecordsRaw.id, row.id));
      continue;
    }

    liveExternalIds.add(externalIdFromSourceRecordId(row.sourceRecordId));
  }

  if (!deleteIndexedRecords) return;

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

function classifyTable(table: TableSchema): 'entity' | 'lookup' | 'junction' | 'config' {
  const primaryKey = new Set(table.primaryKey);
  const foreignKeyColumns = new Set(table.foreignKeys.map((foreignKey) => foreignKey.column));
  const nonKeyColumns = table.columns.filter(
    (column) => !primaryKey.has(column.name) && !foreignKeyColumns.has(column.name),
  );

  if (table.primaryKey.length >= 2 && table.foreignKeys.length >= 2 && nonKeyColumns.length <= 1) {
    return 'junction';
  }

  if (table.name.toLowerCase().includes('config')) {
    return 'config';
  }

  if (table.foreignKeys.length === 0 && table.columns.length <= 4) {
    return 'lookup';
  }

  return 'entity';
}
