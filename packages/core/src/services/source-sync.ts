import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import type { ShopifyClient } from '../connectors/shopify/types.js';
import { createShopifyClientForSource } from '../connectors/shopify/factory.js';
import { GatewayError } from '../errors/gateway-error.js';
import { getDecryptedSourceConfig } from './sources.js';
import { syncDatabaseSource } from './sync.js';
import { syncShopifySource } from './shopify-sync.js';

export async function syncSource(
  db: Database,
  sourceId: string,
  workspaceId: string,
  encryptionKey: string,
  connectionString: string,
  options: { fullSync?: boolean; useMockProviders?: boolean; client?: ShopifyClient } = {},
): Promise<{ synced: number; tables?: string[] }> {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);

  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  if (source.type === 'database_url') {
    return syncDatabaseSource(
      db,
      sourceId,
      workspaceId,
      encryptionKey,
      connectionString,
      options.fullSync === undefined ? {} : { fullSync: options.fullSync },
    );
  }

  if (source.type === 'shopify') {
    const config = getDecryptedSourceConfig(source, encryptionKey);
    const client =
      options.client ??
      createShopifyClientForSource(
        {
          shopDomain: String(config.shopDomain),
          accessToken: String(config.accessToken),
          ...(typeof config.apiVersion === 'string' ? { apiVersion: config.apiVersion } : {}),
        },
        options.useMockProviders ?? false,
      );

    const result = await syncShopifySource(
      db,
      sourceId,
      workspaceId,
      encryptionKey,
      connectionString,
      client,
      options.fullSync === undefined ? {} : { fullSync: options.fullSync },
    );
    return result;
  }

  throw GatewayError.validation(`Sync is not supported for source type "${source.type}"`);
}
