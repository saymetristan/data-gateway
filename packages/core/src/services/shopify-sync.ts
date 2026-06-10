import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mappings, sources } from '../db/schema/index.js';
import { normalizeShopifyDomain } from '../connectors/shopify/domain.js';
import type { ShopifyClient } from '../connectors/shopify/types.js';
import {
  collectionToRawPayload,
  productToRawPayload,
  rawRecordIdsForProduct,
  variantToRawPayload,
} from '../connectors/shopify/transform.js';
import { GatewayError } from '../errors/gateway-error.js';
import { enqueueJob } from '../queue/boss.js';
import { SOURCE_INDEX_JOB, SOURCE_PROFILE_JOB } from '../queue/jobs.js';
import { getDecryptedSourceConfig, updateSourceConfig } from './sources.js';
import {
  deleteRawRecords,
  removeStaleRawRecords,
  removeStaleRawRecordsByPrefix,
  removeStaleVariantRecordsForProduct,
  upsertRawRecord,
} from './raw-records.js';

const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

const WEBHOOK_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
  'inventory_levels/update',
] as const;

export async function syncShopifySource(
  db: Database,
  sourceId: string,
  workspaceId: string,
  encryptionKey: string,
  connectionString: string,
  client: ShopifyClient,
  options: { fullSync?: boolean } = {},
): Promise<{ synced: number }> {
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);

  if (!source) {
    throw GatewayError.notFound('Source not found');
  }
  if (source.type !== 'shopify') {
    throw GatewayError.validation('Sync is only supported for shopify sources');
  }

  const config = getDecryptedSourceConfig(source, encryptionKey);
  const syncState = (config.syncState as { lastSyncedAt?: string } | undefined) ?? {};
  const syncStartedAt = new Date();
  const seenRecordIds = new Set<string>();
  const seenCollectionRecordIds = new Set<string>();
  let synced = 0;

  try {
    let collectionsCursor: string | null | undefined;
    do {
      const page = await client.fetchCollections(
        collectionsCursor ? { cursor: collectionsCursor } : {},
      );
      for (const collection of page.items) {
        const sourceRecordId = `collections:${collection.id}`;
        seenRecordIds.add(sourceRecordId);
        seenCollectionRecordIds.add(sourceRecordId);
        const changed = await upsertRawRecord(
          db,
          sourceId,
          sourceRecordId,
          collectionToRawPayload(collection),
        );
        if (changed) synced += 1;
      }
      collectionsCursor = page.nextCursor;
    } while (collectionsCursor);

    let productsCursor: string | null | undefined;
    const updatedAtMin = !options.fullSync
      ? overlappedTimestamp(syncState.lastSyncedAt)
      : undefined;
    do {
      const page = await client.fetchProducts({
        ...(productsCursor ? { cursor: productsCursor } : {}),
        ...(updatedAtMin ? { updatedAtMin } : {}),
      });
      for (const product of page.items) {
        synced += await upsertShopifyProduct(db, sourceId, product, seenRecordIds);
      }
      productsCursor = page.nextCursor;
    } while (productsCursor);

    if (options.fullSync) {
      await removeStaleRawRecords(db, sourceId, seenRecordIds);
    } else {
      await removeStaleRawRecordsByPrefix(db, sourceId, 'collections:', seenCollectionRecordIds);
    }

    const lastSyncedAt = syncStartedAt.toISOString();
    await updateSourceConfig(db, sourceId, workspaceId, { syncState: { lastSyncedAt } }, encryptionKey);
    await db
      .update(sources)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(sources.id, sourceId));

    await enqueuePostSyncJob(db, sourceId, workspaceId, connectionString);

    return { synced };
  } finally {
    await client.close();
  }
}

export async function upsertShopifyProduct(
  db: Database,
  sourceId: string,
  product: Parameters<typeof productToRawPayload>[0],
  seenRecordIds?: Set<string>,
): Promise<number> {
  let synced = 0;
  const ids = rawRecordIdsForProduct(product);

  if (seenRecordIds) {
    seenRecordIds.add(ids.productId);
    for (const variantId of ids.variantIds) {
      seenRecordIds.add(variantId);
    }
  }

  if (await upsertRawRecord(db, sourceId, ids.productId, productToRawPayload(product))) {
    synced += 1;
  }

  for (const variant of product.variants) {
    if (
      await upsertRawRecord(
        db,
        sourceId,
        `variants:${variant.id}`,
        variantToRawPayload(product, variant),
      )
    ) {
      synced += 1;
    }
  }

  // With exactly 100 variants the page may be truncated by the GraphQL
  // `variants(first: 100)` cap; skip cleanup to avoid deleting live variants.
  if (product.variants.length < 100) {
    await removeStaleVariantRecordsForProduct(db, sourceId, product.id, new Set(ids.variantIds));
  }

  return synced;
}

export async function deleteShopifyProduct(
  db: Database,
  sourceId: string,
  productId: string,
  client: ShopifyClient,
): Promise<void> {
  const product = await client.fetchProductById(productId);
  const recordIds = product
    ? [rawRecordIdsForProduct(product).productId, ...rawRecordIdsForProduct(product).variantIds]
    : [`products:${productId}`];
  await deleteRawRecords(db, sourceId, recordIds);
}

export async function registerShopifyWebhooks(
  client: ShopifyClient,
  publicApiUrl: string,
): Promise<void> {
  const callbackUrl = `${publicApiUrl.replace(/\/$/, '')}/webhooks/shopify`;
  await client.registerWebhooks(callbackUrl, [...WEBHOOK_TOPICS]);
}

async function enqueuePostSyncJob(
  db: Database,
  sourceId: string,
  workspaceId: string,
  connectionString: string,
): Promise<void> {
  const [activeMapping] = await db
    .select({ id: mappings.id })
    .from(mappings)
    .where(and(eq(mappings.sourceId, sourceId), eq(mappings.status, 'active')))
    .orderBy(desc(mappings.version))
    .limit(1);

  if (activeMapping) {
    await enqueueJob(connectionString, SOURCE_INDEX_JOB, {
      sourceId,
      workspaceId,
      invalidateMaturity: false,
    });
    return;
  }

  await enqueueJob(connectionString, SOURCE_PROFILE_JOB, { sourceId, workspaceId });
}

export async function findShopifySourceByDomain(
  db: Database,
  shopDomain: string,
): Promise<{ id: string; workspaceId: string; config: unknown } | null> {
  const normalized = normalizeShopifyDomain(shopDomain);
  const rows = await db
    .select({
      id: sources.id,
      workspaceId: sources.workspaceId,
      config: sources.config,
      type: sources.type,
    })
    .from(sources)
    .where(eq(sources.type, 'shopify'));

  for (const row of rows) {
    const config = row.config as Record<string, unknown>;
    const domain = typeof config.shopDomain === 'string'
      ? normalizeShopifyDomain(config.shopDomain)
      : '';
    if (domain === normalized) {
      return row;
    }
  }

  return null;
}

function overlappedTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return undefined;
  return new Date(Math.max(0, time - INCREMENTAL_OVERLAP_MS)).toISOString();
}
