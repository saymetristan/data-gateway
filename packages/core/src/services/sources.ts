import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sourceRecordsRaw, sources } from '../db/schema/index.js';
import { decryptSourceConfig, encryptSourceConfig } from '../crypto/credentials.js';
import { createDatabaseConnector } from '../connectors/factory.js';
import { createShopifyClient } from '../connectors/shopify/client.js';
import { normalizeShopifyDomain } from '../connectors/shopify/domain.js';
import { createMockShopifyClient } from '../connectors/shopify/mock.js';
import { registerShopifyWebhooks } from './shopify-sync.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { CreateSourceInput } from '../schemas/index.js';
import { enqueueJob } from '../queue/boss.js';
import {
  SOURCE_SYNC_EXPIRE_IN_HOURS,
  SOURCE_SYNC_JOB,
  SOURCE_SYNC_SINGLETON_MINUTES,
} from '../queue/jobs.js';

export async function createSourceWithValidation(
  db: Database,
  workspaceId: string,
  input: CreateSourceInput,
  encryptionKey: string,
  connectionString: string,
  options: { publicApiUrl?: string; useMockProviders?: boolean } = {},
) {
  if (input.type === 'database_url') {
    const connector = createDatabaseConnector(input.config.connectionUrl);
    try {
      const validation = await connector.validateReadOnlyConnection();
      if (!validation.ok) {
        throw GatewayError.unprocessable(
          'Database connection failed',
          'Unable to validate database connection',
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

  if (input.type === 'shopify') {
    input.config.shopDomain = normalizeShopifyDomain(input.config.shopDomain);
    await assertUniqueShopifyDomain(db, input.config.shopDomain);
    const client = options.useMockProviders
      ? createMockShopifyClient()
      : createShopifyClient({
          shopDomain: input.config.shopDomain,
          ...(input.config.accessToken ? { accessToken: input.config.accessToken } : {}),
          ...(input.config.clientId ? { clientId: input.config.clientId } : {}),
          ...(input.config.clientSecret ? { clientSecret: input.config.clientSecret } : {}),
          ...(input.config.apiVersion ? { apiVersion: input.config.apiVersion } : {}),
        });
    try {
      const validation = await client.validateConnection();
      if (!validation.ok) {
        throw GatewayError.unprocessable(
          'Shopify connection failed',
          'Unable to validate Shopify credentials',
        );
      }
    } finally {
      await client.close();
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

  if (input.type === 'database_url' || input.type === 'shopify') {
    try {
      await enqueueJob(
        connectionString,
        SOURCE_SYNC_JOB,
        {
          sourceId: source.id,
          workspaceId,
          fullSync: true,
        },
        {
          singletonKey: `source-sync:${source.id}`,
          singletonMinutes: SOURCE_SYNC_SINGLETON_MINUTES,
          expireInHours: SOURCE_SYNC_EXPIRE_IN_HOURS,
        },
      );

      if (
        input.type === 'shopify' &&
        input.config.webhookSecret &&
        options.publicApiUrl &&
        !options.useMockProviders
      ) {
        const client = createShopifyClient({
          shopDomain: input.config.shopDomain,
          ...(input.config.accessToken ? { accessToken: input.config.accessToken } : {}),
          ...(input.config.clientId ? { clientId: input.config.clientId } : {}),
          ...(input.config.clientSecret ? { clientSecret: input.config.clientSecret } : {}),
          ...(input.config.apiVersion ? { apiVersion: input.config.apiVersion } : {}),
        });
        try {
          await registerShopifyWebhooks(client, options.publicApiUrl);
        } finally {
          await client.close();
        }
      }
    } catch (error) {
      await db.delete(sources).where(eq(sources.id, source.id));
      throw error;
    }
  }

  return source;
}

async function assertUniqueShopifyDomain(db: Database, shopDomain: string): Promise<void> {
  const rows = await db
    .select({ id: sources.id, config: sources.config })
    .from(sources)
    .where(eq(sources.type, 'shopify'));

  for (const row of rows) {
    const config = row.config as Record<string, unknown>;
    const existingDomain = typeof config.shopDomain === 'string'
      ? normalizeShopifyDomain(config.shopDomain)
      : '';
    if (existingDomain === shopDomain) {
      throw GatewayError.conflict('Shopify shop domain is already connected');
    }
  }
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

  const [rawCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId));

  return {
    sourceId: source.id,
    maturityStatus: source.maturityStatus,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
    rawRecords: rawCount?.count ?? 0,
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
