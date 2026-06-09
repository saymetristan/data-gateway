import { eq, and } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { decryptSourceConfig, encryptSourceConfig } from '../crypto/credentials.js';
import { createDatabaseConnector } from '../connectors/factory.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { CreateSourceInput } from '../schemas/index.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_SYNC_JOB } from '../queue/jobs.js';

type SyncState = Record<string, { cursorColumn?: string; cursorValue?: string }>;

export async function createSourceWithValidation(
  db: Database,
  workspaceId: string,
  input: CreateSourceInput,
  encryptionKey: string,
  connectionString: string,
) {
  if (input.type === 'database_url') {
    const connector = createDatabaseConnector(input.config.connectionUrl);
    try {
      const validation = await connector.validateReadOnlyConnection();
      if (!validation.ok) {
        throw GatewayError.unprocessable(
          'Database connection failed',
          validation.message,
        );
      }
      if (!validation.readOnly) {
        throw GatewayError.unprocessable(
          'Database connection must use a read-only user (SELECT-only)',
        );
      }
    } finally {
      await connector.close();
    }
  }

  const encryptedConfig = encryptSourceConfig(
    input.type,
    { ...input.config },
    encryptionKey,
  );

  const [source] = await db
    .insert(sources)
    .values({
      workspaceId,
      type: input.type,
      name: input.name,
      config: encryptedConfig,
      maturityStatus: 'connected',
    })
    .returning();

  if (!source) {
    throw GatewayError.internal('Failed to create source');
  }

  if (input.type === 'database_url') {
    await enqueueJob(connectionString, SOURCE_SYNC_JOB, {
      sourceId: source.id,
      workspaceId,
      fullSync: true,
    });
  }

  return source;
}

export function getDecryptedSourceConfig(
  source: { type: 'database_url' | 'csv' | 'shopify'; config: unknown },
  encryptionKey: string,
): Record<string, unknown> {
  return decryptSourceConfig(
    source.type,
    (source.config ?? {}) as Record<string, unknown>,
    encryptionKey,
  );
}

export async function getSourceStatus(db: Database, sourceId: string) {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  const config = (source.config ?? {}) as Record<string, unknown>;
  const syncState = (config.syncState ?? {}) as SyncState;

  return {
    sourceId: source.id,
    maturityStatus: source.maturityStatus,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
    syncState,
  };
}

export async function updateSourceConfig(
  db: Database,
  sourceId: string,
  workspaceId: string,
  patch: Record<string, unknown>,
  encryptionKey: string,
) {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);

  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  const decrypted = getDecryptedSourceConfig(source, encryptionKey);
  const merged = { ...decrypted, ...patch };
  const encrypted = encryptSourceConfig(source.type, merged, encryptionKey);

  await db
    .update(sources)
    .set({ config: encrypted, updatedAt: new Date() })
    .where(eq(sources.id, sourceId));
}
