import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { ShopifyClient } from '../connectors/shopify/types.js';
import { parseShopifyGid } from '../connectors/shopify/gid.js';
import { GatewayError } from '../errors/gateway-error.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_INDEX_JOB, type ShopifyWebhookJobData } from '../queue/jobs.js';
import { sourceRecordsRaw, sources } from '../db/schema/index.js';
import { getDecryptedSourceConfig } from './sources.js';
import { findShopifySourceByDomain, upsertShopifyProduct } from './shopify-sync.js';
import { deleteRawRecords } from './raw-records.js';

export async function processShopifyWebhook(
  db: Database,
  connectionString: string,
  client: ShopifyClient,
  data: ShopifyWebhookJobData,
): Promise<void> {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, data.sourceId), eq(sources.workspaceId, data.workspaceId)))
    .limit(1);

  if (!source || source.type !== 'shopify') {
    throw GatewayError.notFound('Shopify source not found');
  }

  try {
    switch (data.topic) {
      case 'products/create':
      case 'products/update':
        await handleProductUpsert(db, data.sourceId, data.payload, client);
        break;
      case 'products/delete':
        await handleProductDelete(db, data.sourceId, data.payload);
        break;
      case 'inventory_levels/update':
        await handleInventoryUpdate(db, data.sourceId, data.payload, client);
        break;
      default:
        return;
    }

    await enqueueJob(connectionString, SOURCE_INDEX_JOB, {
      sourceId: data.sourceId,
      workspaceId: data.workspaceId,
      invalidateMaturity: false,
    });
  } finally {
    await client.close();
  }
}

export async function resolveShopifyWebhookSource(
  db: Database,
  shopDomain: string,
  encryptionKey: string,
): Promise<{ sourceId: string; workspaceId: string; webhookSecret: string } | null> {
  const source = await findShopifySourceByDomain(db, shopDomain);
  if (!source) return null;

  const config = getDecryptedSourceConfig(
    { type: 'shopify', config: source.config },
    encryptionKey,
  );
  const webhookSecret = typeof config.webhookSecret === 'string' ? config.webhookSecret : '';
  if (!webhookSecret) return null;

  return {
    sourceId: source.id,
    workspaceId: source.workspaceId,
    webhookSecret,
  };
}

async function handleProductUpsert(
  db: Database,
  sourceId: string,
  payload: Record<string, unknown>,
  client: ShopifyClient,
): Promise<void> {
  const productId = extractProductId(payload);
  if (!productId) return;

  const product = await client.fetchProductById(productId);
  if (!product) return;
  await upsertShopifyProduct(db, sourceId, product);
}

async function handleProductDelete(
  db: Database,
  sourceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const productId = extractProductId(payload);
  if (!productId) return;
  await deleteShopifyProductRecords(db, sourceId, productId);
}

async function handleInventoryUpdate(
  db: Database,
  sourceId: string,
  payload: Record<string, unknown>,
  client: ShopifyClient,
): Promise<void> {
  const productId = typeof payload.product_id === 'number' || typeof payload.product_id === 'string'
    ? String(payload.product_id)
    : null;
  if (!productId) return;

  const product = await client.fetchProductById(productId);
  if (!product) return;
  await upsertShopifyProduct(db, sourceId, product);
}

function extractProductId(payload: Record<string, unknown>): string | null {
  if (typeof payload.id === 'number' || typeof payload.id === 'string') {
    return String(payload.id);
  }
  if (typeof payload.admin_graphql_api_id === 'string') {
    return parseShopifyGid(payload.admin_graphql_api_id);
  }
  return null;
}

export async function deleteShopifyProductRecords(
  db: Database,
  sourceId: string,
  productId: string,
): Promise<void> {
  const rows = await db
    .select({
      sourceRecordId: sourceRecordsRaw.sourceRecordId,
      payload: sourceRecordsRaw.payload,
    })
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId));

  const recordIds = rows
    .filter((row) => {
      if (row.sourceRecordId === `products:${productId}`) return true;
      if (!row.sourceRecordId.startsWith('variants:')) return false;
      const payload = row.payload as Record<string, unknown>;
      return String(payload.productId) === productId;
    })
    .map((row) => row.sourceRecordId);

  if (recordIds.length > 0) {
    await deleteRawRecords(db, sourceId, recordIds);
  }
}
