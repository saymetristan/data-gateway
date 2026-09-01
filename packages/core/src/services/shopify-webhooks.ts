import { and, eq, like, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { ShopifyClient } from '../connectors/shopify/types.js';
import { parseShopifyGid } from '../connectors/shopify/gid.js';
import { GatewayError } from '../errors/gateway-error.js';
import { enqueueSourceIndexJob } from '../queue/boss.js';
import { type ShopifyWebhookJobData } from '../queue/jobs.js';
import { sourceRecordsRaw, sources } from '../db/schema/index.js';
import { getDecryptedSourceConfig } from './sources.js';
import { findShopifySourceByDomain, upsertShopifyProduct } from './shopify-sync.js';
import { deleteRawRecords } from './raw-records.js';
import { completeWebhookEvent, failWebhookEvent, startWebhookEventProcessing } from './webhooks.js';

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

  const shouldProcess = await startWebhookEventProcessing(db, {
    sourceId: data.sourceId,
    provider: 'shopify',
    webhookId: data.webhookId ?? null,
    topic: data.topic,
  });
  if (!shouldProcess) {
    await client.close();
    return;
  }

  try {
    let changed = false;
    switch (data.topic) {
      case 'products/create':
      case 'products/update':
        changed = await handleProductUpsert(db, data.sourceId, data.payload, client);
        break;
      case 'products/delete':
        changed = await handleProductDelete(db, data.sourceId, data.payload);
        break;
      case 'inventory_levels/update':
        changed = await handleInventoryUpdate(db, data.sourceId, data.payload, client);
        break;
      default:
        break;
    }

    if (changed) {
      await enqueueSourceIndexJob(connectionString, {
        sourceId: data.sourceId,
        workspaceId: data.workspaceId,
        invalidateMaturity: false,
      });
    }
    await completeWebhookEvent(db, 'shopify', data.webhookId);
  } catch (error) {
    await failWebhookEvent(db, 'shopify', data.webhookId);
    throw error;
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
): Promise<boolean> {
  const productId = extractProductId(payload);
  if (!productId) return false;

  const product = await client.fetchProductById(productId);
  if (!product) return false;
  await upsertShopifyProduct(db, sourceId, product);
  return true;
}

async function handleProductDelete(
  db: Database,
  sourceId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const productId = extractProductId(payload);
  if (!productId) return false;
  await deleteShopifyProductRecords(db, sourceId, productId);
  return true;
}

async function handleInventoryUpdate(
  db: Database,
  sourceId: string,
  payload: Record<string, unknown>,
  client: ShopifyClient,
): Promise<boolean> {
  const inventoryItemId =
    typeof payload.inventory_item_id === 'number' || typeof payload.inventory_item_id === 'string'
      ? String(payload.inventory_item_id)
      : typeof payload.admin_graphql_api_id === 'string'
        ? parseShopifyGid(payload.admin_graphql_api_id)
        : null;
  if (!inventoryItemId) return false;

  const product = await client.fetchProductByInventoryItemId(inventoryItemId);
  if (!product) return false;
  await upsertShopifyProduct(db, sourceId, product);
  return true;
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
    .where(
      and(
        eq(sourceRecordsRaw.sourceId, sourceId),
        or(
          eq(sourceRecordsRaw.sourceRecordId, `products:${productId}`),
          and(
            like(sourceRecordsRaw.sourceRecordId, 'variants:%'),
            sql`${sourceRecordsRaw.payload}->>'productId' = ${productId}`,
          ),
        ),
      ),
    );

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
