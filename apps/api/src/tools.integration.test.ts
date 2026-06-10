import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activateSource,
  closeDb,
  createDb,
  createMockShopifyClient,
  createSourceMapping,
  encryptSourceConfig,
  evalRuns,
  generateApiKey,
  generateEmbeddingsForRecords,
  hashApiKey,
  indexSource,
  MockEmbeddingProvider,
  MockLlmProvider,
  profileSource,
  queryLogs,
  records,
  runEvalSet,
  runMigrations,
  sources,
  syncShopifySource,
  workspaces,
  apiKeys,
  type Database,
} from '@data-gateway/core';
import { loadShopifyMappingFixture } from '../../../packages/core/src/test/shopify-mapping.js';
import { seedShopifyEvalSet } from '../../../packages/core/src/test/shopify-evals.js';
import { createApp } from './app.js';
import type { ApiEnv } from './env.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/data_gateway';
const ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');

function isValidToolSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === 'object' &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    schema.additionalProperties === false
  );
}

async function bootstrapAgentReadyShopify(
  db: Database,
  testUrl: string,
  workspaceId: string,
) {
  const encryptedConfig = encryptSourceConfig(
    'shopify',
    {
      shopDomain: 'tools-shop.myshopify.com',
      accessToken: 'shpat_tools',
      webhookSecret: 'whsec_tools',
    },
    ENCRYPTION_KEY,
  );

  const [source] = await db
    .insert(sources)
    .values({
      workspaceId,
      type: 'shopify',
      name: 'Tools Shop',
      config: encryptedConfig,
      maturityStatus: 'connected',
    })
    .returning();
  if (!source) throw new Error('source missing');

  const client = createMockShopifyClient();
  await syncShopifySource(
    db,
    source.id,
    workspaceId,
    ENCRYPTION_KEY,
    testUrl,
    client,
    { fullSync: true },
  );
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

  const evalSet = await seedShopifyEvalSet(db, workspaceId, source.id);
  const [run] = await db
    .insert(evalRuns)
    .values({ evalSetId: evalSet.id, status: 'running', metrics: {} })
    .returning();
  if (!run) throw new Error('run missing');
  await runEvalSet(db, run.id, workspaceId, new MockEmbeddingProvider(1024));
  await activateSource(db, workspaceId, source.id);

  return { source, mapping };
}

describe.runIf(hasDatabase)('tools API integration', () => {
  const adminKey = 'dgw_admin_tools_test_key_123456';
  let app: ReturnType<typeof createApp>;
  let db: Database;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL);
    db = createDb(DATABASE_URL);
    const env: ApiEnv = {
      DATABASE_URL,
      PORT: 3000,
      ADMIN_API_KEY: adminKey,
      CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY,
      NODE_ENV: 'test',
      EMBEDDING_MODEL: 'mock-embedding',
      EMBEDDING_DIMENSIONS: 1024,
      LLM_MODEL: 'mock-llm',
      USE_MOCK_PROVIDERS: true,
    };
    app = createApp({
      env,
      db,
      embeddingProvider: new MockEmbeddingProvider(1024),
      llmProvider: new MockLlmProvider(),
    });
  });

  it('manifest excluye fuentes no agent_ready', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Tools WS', slug: `tools-${Date.now()}`, settings: {} })
      .returning();
    if (!workspace) throw new Error('workspace missing');

    const encryptedConfig = encryptSourceConfig(
      'shopify',
      { shopDomain: 'indexed-only.myshopify.com', accessToken: 'shpat_x', webhookSecret: 'whsec_x' },
      ENCRYPTION_KEY,
    );
    await db.insert(sources).values({
      workspaceId: workspace.id,
      type: 'shopify',
      name: 'Indexed Only',
      config: encryptedConfig,
      maturityStatus: 'indexed',
    });

    const { key } = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: workspace.id,
      keyHash: hashApiKey(key),
      prefix: key.slice(0, 16),
      scopes: ['tools:read', 'tools:invoke'],
    });

    const res = await app.request('/tools', {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { tools: Array<{ name: string }> };
    expect(manifest.tools).toHaveLength(0);
  });

  it('manifest e invoke respetan agent_ready, scopes y filtros', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Tools Ready', slug: `tools-ready-${Date.now()}`, settings: {} })
      .returning();
    if (!workspace) throw new Error('workspace missing');

    await bootstrapAgentReadyShopify(db, DATABASE_URL, workspace.id);

    const { key: toolsKey } = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: workspace.id,
      keyHash: hashApiKey(toolsKey),
      prefix: toolsKey.slice(0, 16),
      scopes: ['tools:read', 'tools:invoke'],
    });

    const { key: readOnlyKey } = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: workspace.id,
      keyHash: hashApiKey(readOnlyKey),
      prefix: readOnlyKey.slice(0, 16),
      scopes: ['tools:read'],
    });

    const manifestRes = await app.request('/tools', {
      headers: { Authorization: `Bearer ${toolsKey}` },
    });
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    const searchTool = manifest.tools.find((tool) => tool.name === 'search_variant');
    expect(searchTool).toBeDefined();
    expect(isValidToolSchema(searchTool!.inputSchema)).toBe(true);

    const invokeDenied = await app.request('/tools/search_variant/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readOnlyKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: { query: 'SHOP-SKU' } }),
    });
    expect(invokeDenied.status).toBe(401);

    const invokeMissing = await app.request('/tools/does_not_exist/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${toolsKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: { query: 'x' } }),
    });
    expect(invokeMissing.status).toBe(404);

    const invokeBadArgs = await app.request('/tools/search_variant/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${toolsKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: { limit: 'not-a-number' } }),
    });
    expect(invokeBadArgs.status).toBe(422);

    const invokeOk = await app.request('/tools/search_variant/invoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${toolsKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args: { query: 'SHOP-SKU-0001-1', limit: 5 } }),
    });
    expect(invokeOk.status).toBe(200);
    const body = (await invokeOk.json()) as {
      kind: string;
      results: Array<{ data: Record<string, unknown> }>;
      applied_filters: Array<{ field: string; value: unknown }>;
    };
    expect(body.kind).toBe('search');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((row) => !('cost' in row.data))).toBe(true);
    expect(body.applied_filters.some((filter) => filter.field === 'available')).toBe(true);

    const logs = await db
      .select()
      .from(queryLogs)
      .where(eq(queryLogs.workspaceId, workspace.id));
    const toolLog = logs.find((log) => {
      const structured = log.structuredQuery as Record<string, unknown> | null;
      return structured?.toolName === 'search_variant';
    });
    expect(toolLog).toBeDefined();
  });
});

describe.runIf(hasDatabase)('tools cleanup', () => {
  it('closes db pool', async () => {
    await closeDb();
  });
});
