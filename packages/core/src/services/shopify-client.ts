import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { createShopifyClientForSource } from '../connectors/shopify/factory.js';
import type { ShopifyClient } from '../connectors/shopify/types.js';
import { GatewayError } from '../errors/gateway-error.js';
import { getDecryptedSourceConfig } from './sources.js';

export async function createShopifyClientForSourceRecord(
  db: Database,
  sourceId: string,
  encryptionKey: string,
  useMockProviders = false,
): Promise<ShopifyClient> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source || source.type !== 'shopify') {
    throw GatewayError.notFound('Shopify source not found');
  }

  const config = getDecryptedSourceConfig(source, encryptionKey);
  return createShopifyClientForSource(
    {
      shopDomain: String(config.shopDomain),
      accessToken: String(config.accessToken),
      ...(typeof config.apiVersion === 'string' ? { apiVersion: config.apiVersion } : {}),
    },
    useMockProviders,
  );
}
