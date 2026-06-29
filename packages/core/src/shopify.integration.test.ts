import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activateSource,
  closeDb,
  createMockShopifyClient,
  createSourceMapping,
  encryptSourceConfig,
  evalRuns,
  executeQuery,
  generateEmbeddingsForRecords,
  indexSource,
  MockEmbeddingProvider,
  MockLlmProvider,
  processShopifyWebhook,
  profileSource,
  records,
  runEvalSet,
  sourceRecordsRaw,
  sources,
  syncShopifySource,
  workspaces,
} from './index.js';
import { withTestDatabase } from './test/db-helper.js';
import { loadShopifyMappingFixture } from './test/shopify-mapping.js';
import { seedShopifyEvalSet } from './test/shopify-evals.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');

async function bootstrapShopifySource(
  db: Parameters<Parameters<typeof withTestDatabase>[0]>[0],
  testUrl: string,
  workspaceId: string,
  shopDomain = 'mock-shop.myshopify.com',
) {
  const encryptedConfig = encryptSourceConfig(
    'shopify',
    {
      shopDomain,
      accessToken: 'shpat_test_token',
      webhookSecret: 'whsec_test_secret',
    },
    ENCRYPTION_KEY,
  );

  const [source] = await db
    .insert(sources)
    .values({
      workspaceId,
      type: 'shopify',
      name: 'Shopify Mock',
      config: encryptedConfig,
      maturityStatus: 'connected',
    })
    .returning();
  if (!source) throw new Error('source missing');

  const client = createMockShopifyClient();
  await syncShopifySource(db, source.id, workspaceId, ENCRYPTION_KEY, testUrl, client, {
    fullSync: true,
  });
  await profileSource(db, source.id);
  const mapping = await createSourceMapping(db, source.id, workspaceId, {
    document: loadShopifyMappingFixture(),
  });
  await indexSource(db, source.id, workspaceId, testUrl, new MockLlmProvider());

  const indexedRecords = await db.select().from(records).where(eq(records.sourceId, source.id));
  await generateEmbeddingsForRecords(
    db,
    source.id,
    indexedRecords.map((row) => row.id),
    mapping.version,
    new MockEmbeddingProvider(1024),
  );

  return { source, mapping, client };
}

describe.runIf(hasDatabase)('shopify integration', () => {
  it('E2E: sync → profile → mapping → query → evals → activate', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({
          name: 'Shopify',
          slug: `shopify-${crypto.randomUUID().slice(0, 8)}`,
          settings: {},
        })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapShopifySource(db, testUrl, workspace.id);
      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'SHOP-SKU-0001-1', limit: 5, useLlmFallback: false, sourceId: source.id },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });
      expect(response.results.length).toBeGreaterThan(0);

      const evalSet = await seedShopifyEvalSet(db, workspace.id, source.id);
      const [run] = await db
        .insert(evalRuns)
        .values({ evalSetId: evalSet.id, status: 'running', metrics: {} })
        .returning();
      if (!run) throw new Error('run missing');

      await runEvalSet(db, run.id, workspace.id, new MockEmbeddingProvider(1024));
      const activated = await activateSource(db, workspace.id, source.id);
      expect(activated.maturityStatus).toBe('agent_ready');
    });
  });

  it('search_variant devuelve variantes agotadas cuando no se filtra disponibilidad', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({
          name: 'Shopify Stock',
          slug: `shopify-stock-${crypto.randomUUID().slice(0, 8)}`,
          settings: {},
        })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapShopifySource(db, testUrl, workspace.id);
      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'SHOP-SKU-0006-3', limit: 5, useLlmFallback: false, sourceId: source.id },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.applied_filters.some((filter) => filter.field === 'available')).toBe(false);
      expect(response.results.some((result) => result.data.sku === 'SHOP-SKU-0006-3')).toBe(true);
      const soldOut = response.results.find((result) => result.data.sku === 'SHOP-SKU-0006-3');
      expect(soldOut?.data.available).toBe(false);
      expect(soldOut?.data.inventoryQuantity).toBe(0);
      expect(soldOut?.data.productUrl).toBeTruthy();
      expect(soldOut?.data.imageUrl).toBeTruthy();
    });
  });

  it('sync incremental no reescribe raw sin cambios', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({
          name: 'Incremental',
          slug: `inc-${crypto.randomUUID().slice(0, 8)}`,
          settings: {},
        })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapShopifySource(db, testUrl, workspace.id);
      const before = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source.id));

      const client = createMockShopifyClient();
      await syncShopifySource(db, source.id, workspace.id, ENCRYPTION_KEY, testUrl, client, {
        fullSync: false,
      });

      const after = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source.id));
      expect(after.length).toBe(before.length);
    });
  });

  it('webhook update re-index no demota agent_ready', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Webhook', slug: `wh-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source, client } = await bootstrapShopifySource(db, testUrl, workspace.id);
      const evalSet = await seedShopifyEvalSet(db, workspace.id, source.id);
      const [run] = await db
        .insert(evalRuns)
        .values({ evalSetId: evalSet.id, status: 'running', metrics: {} })
        .returning();
      if (!run) throw new Error('run missing');
      await runEvalSet(db, run.id, workspace.id, new MockEmbeddingProvider(1024));
      await activateSource(db, workspace.id, source.id);

      const product = client.getProduct('1');
      if (!product) throw new Error('product missing');
      product.title = 'Producto Shopify 1 actualizado';
      client.updateProduct(product);

      await processShopifyWebhook(db, testUrl, client, {
        sourceId: source.id,
        workspaceId: workspace.id,
        topic: 'products/update',
        payload: { id: 1 },
      });

      const [updated] = await db.select().from(sources).where(eq(sources.id, source.id)).limit(1);
      expect(updated?.maturityStatus).toBe('agent_ready');
    });
  });

  it('webhook de inventory_levels/update refetchea por inventory_item_id', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Inventory', slug: `inv-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source, client } = await bootstrapShopifySource(db, testUrl, workspace.id);
      const product = client.getProduct('1');
      const variant = product?.variants[0];
      if (!product || !variant?.inventoryItemId) throw new Error('variant missing');
      variant.inventoryQuantity += 7;
      client.updateProduct(product);

      await processShopifyWebhook(db, testUrl, client, {
        sourceId: source.id,
        workspaceId: workspace.id,
        topic: 'inventory_levels/update',
        payload: { inventory_item_id: variant.inventoryItemId },
      });

      const [updated] = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceRecordId, `variants:${variant.id}`))
        .limit(1);
      const payload = updated?.payload as Record<string, unknown> | undefined;
      expect(payload?.inventoryQuantity).toBe(variant.inventoryQuantity);
    });
  });

  it('webhook update elimina variantes que ya no existen en el producto', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({
          name: 'Variant Delete',
          slug: `var-del-${crypto.randomUUID().slice(0, 8)}`,
          settings: {},
        })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source, client } = await bootstrapShopifySource(db, testUrl, workspace.id);
      const product = client.getProduct('3');
      const removed = product?.variants[0];
      if (!product || !removed) throw new Error('variant missing');
      product.variants = product.variants.slice(1);
      client.updateProduct(product);

      await processShopifyWebhook(db, testUrl, client, {
        sourceId: source.id,
        workspaceId: workspace.id,
        topic: 'products/update',
        payload: { id: product.id },
      });

      const rows = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source.id));
      expect(rows.some((row) => row.sourceRecordId === `variants:${removed.id}`)).toBe(false);
    });
  });

  it('cross-workspace: webhook solo toca la fuente del shop', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [wsA] = await db
        .insert(workspaces)
        .values({ name: 'Shop A', slug: `wsa-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      const [wsB] = await db
        .insert(workspaces)
        .values({ name: 'Shop B', slug: `wsb-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!wsA || !wsB) throw new Error('workspace missing');

      const { source: sourceA, client: clientA } = await bootstrapShopifySource(
        db,
        testUrl,
        wsA.id,
        'shop-a.myshopify.com',
      );
      const { source: sourceB } = await bootstrapShopifySource(
        db,
        testUrl,
        wsB.id,
        'shop-b.myshopify.com',
      );

      const beforeB = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, sourceB.id));

      const product = clientA.getProduct('1');
      if (!product) throw new Error('product missing');
      product.title = 'Solo workspace A';
      clientA.updateProduct(product);

      await processShopifyWebhook(db, testUrl, clientA, {
        sourceId: sourceA.id,
        workspaceId: wsA.id,
        topic: 'products/update',
        payload: { id: 1 },
      });

      const afterB = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, sourceB.id));
      expect(afterB).toEqual(beforeB);
    });
  });

  it('webhook delete elimina raw del producto', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Delete', slug: `del-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source, client } = await bootstrapShopifySource(db, testUrl, workspace.id);
      await processShopifyWebhook(db, testUrl, client, {
        sourceId: source.id,
        workspaceId: workspace.id,
        topic: 'products/delete',
        payload: { id: 1 },
      });

      const rows = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source.id));
      expect(rows.some((row) => row.sourceRecordId === 'products:1')).toBe(false);
    });
  });
});

describe.runIf(hasDatabase)('cleanup shopify integration', () => {
  it('closes shared pools', async () => {
    await closeDb();
  });
});
