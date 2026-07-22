import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  closeDb,
  runMigrations,
  apiKeys,
  mappings,
  sourceProfiles,
  sources,
  workspaces,
  encryptSourceConfig,
  computeShopifyHmac,
  generateApiKey,
  MockEmbeddingProvider,
  MockLlmProvider,
  type Database,
} from '@data-gateway/core';
import { createApp } from './app.js';
import type { ApiEnv } from './env.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/data_gateway';
const ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');
const FIXTURE_URL =
  process.env.FIXTURE_DATABASE_URL ??
  'postgresql://readonly_user:readonly_pass@localhost:5433/catalog';

describe.runIf(hasDatabase)('API integration', () => {
  const adminKey = 'dgw_admin_test_key_1234567890';
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
      EMBEDDING_SOFT_DEADLINE_MS: 1500,
      EMBEDDING_HARD_TIMEOUT_MS: 3000,
      EMBEDDING_CIRCUIT_FAILURE_THRESHOLD: 5,
      EMBEDDING_CIRCUIT_RECOVERY_MS: 30000,
      ENABLE_QUERY_SYNONYM_EXPANSION: true,
      LLM_MODEL: 'mock-llm',
      USE_MOCK_PROVIDERS: true,
      RATE_LIMIT_MAX: 0,
      RATE_LIMIT_WINDOW_MS: 60_000,
    };
    app = createApp({
      env,
      db,
      embeddingProvider: new MockEmbeddingProvider(1024),
      llmProvider: new MockLlmProvider(),
    });
  });

  it('returns 401 without workspace API key on /sources', async () => {
    const res = await app.request('/sources', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 401 on /query when API key lacks query:execute scope', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Query Scope', slug: `query-scope-${Date.now()}` }),
    });
    expect(wsRes.status).toBe(201);
    const workspace = (await wsRes.json()) as { id: string };

    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scopes: ['sources:read'] }),
    });
    expect(keyRes.status).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };

    const res = await app.request('/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'camiseta roja' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 on /evals/run when API key lacks evals:write scope', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Eval Scope', slug: `eval-scope-${Date.now()}` }),
    });
    expect(wsRes.status).toBe(201);
    const workspace = (await wsRes.json()) as { id: string };

    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scopes: ['sources:read'] }),
    });
    expect(keyRes.status).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };

    const res = await app.request('/evals/run', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ evalSetId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(401);
  });

  it('uses dedicated retrieval scopes and creates policy drafts without changing maturity', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Retrieval Policy Scope',
        slug: `retrieval-policy-${Date.now()}`,
      }),
    });
    expect(wsRes.status).toBe(201);
    const workspace = (await wsRes.json()) as { id: string };

    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scopes: ['retrieval:read', 'retrieval:write'] }),
    });
    expect(keyRes.status).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };

    const [source] = await db
      .insert(sources)
      .values({
        workspaceId: workspace.id,
        type: 'csv',
        name: 'Retrieval Source',
        config: {},
        maturityStatus: 'agent_ready',
      })
      .returning();
    if (!source) throw new Error('source missing');
    await db.insert(mappings).values({
      sourceId: source.id,
      version: 1,
      status: 'active',
      document: {
        entities: [
          {
            entity: 'variant',
            sourceTable: 'variants',
            fields: [],
            rules: [],
            embeddingTextTemplate: '{{productTitle}}',
          },
        ],
      },
    });

    const createRes = await app.request(
      `/sources/${source.id}/retrieval-policies`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedActiveVersion: 0,
          document: {
            entities: [
              {
                entity: 'variant',
                synonyms: { entries: { aida: ['cuadrille aida'] } },
              },
            ],
          },
        }),
      },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      version: number;
      status: string;
    };
    expect(created).toMatchObject({ version: 1, status: 'draft' });

    const listRes = await app.request(
      `/sources/${source.id}/retrieval-policies`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    expect(listRes.status).toBe(200);
    expect((await listRes.json()) as unknown[]).toHaveLength(1);

    const [unchanged] = await db
      .select()
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(unchanged?.maturityStatus).toBe('agent_ready');
  });

  it('rejects retrieval policy writes without retrieval:write', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'No Retrieval Scope',
        slug: `no-retrieval-${Date.now()}`,
      }),
    });
    const workspace = (await wsRes.json()) as { id: string };
    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scopes: ['sources:write'] }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    const res = await app.request(
      '/sources/11111111-1111-4111-8111-111111111111/retrieval-policies',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
  });

  it('deletes eval cases without crossing workspace boundaries', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const wsARes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Eval Delete A', slug: `eval-delete-a-${suffix}` }),
    });
    expect(wsARes.status).toBe(201);
    const workspaceA = (await wsARes.json()) as { id: string };

    const wsBRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Eval Delete B', slug: `eval-delete-b-${suffix}` }),
    });
    expect(wsBRes.status).toBe(201);
    const workspaceB = (await wsBRes.json()) as { id: string };

    const keyARes = await app.request(`/workspaces/${workspaceA.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scopes: ['evals:read', 'evals:write'] }),
    });
    expect(keyARes.status).toBe(201);
    const { key: keyA } = (await keyARes.json()) as { key: string };

    const keyBRes = await app.request(`/workspaces/${workspaceB.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scopes: ['evals:write'] }),
    });
    expect(keyBRes.status).toBe(201);
    const { key: keyB } = (await keyBRes.json()) as { key: string };

    const setRes = await app.request('/evals/sets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Case deletion', threshold: 0.8 }),
    });
    expect(setRes.status).toBe(201);
    const evalSet = (await setRes.json()) as { id: string };

    const caseRes = await app.request(`/evals/sets/${evalSet.id}/cases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'producto equivocado',
        expectedExternalIds: ['SKU-WRONG'],
      }),
    });
    expect(caseRes.status).toBe(201);
    const evalCase = (await caseRes.json()) as { id: string };

    const crossWorkspaceDelete = await app.request(
      `/evals/sets/${evalSet.id}/cases/${evalCase.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${keyB}` },
      },
    );
    expect(crossWorkspaceDelete.status).toBe(404);

    const deleteRes = await app.request(`/evals/sets/${evalSet.id}/cases/${evalCase.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(deleteRes.status).toBe(204);
    expect(await deleteRes.text()).toBe('');

    const getSetRes = await app.request(`/evals/sets/${evalSet.id}`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(getSetRes.status).toBe(200);
    const setWithCases = (await getSetRes.json()) as { cases: Array<{ id: string }> };
    expect(setWithCases.cases).toHaveLength(0);

    const secondDelete = await app.request(`/evals/sets/${evalSet.id}/cases/${evalCase.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(secondDelete.status).toBe(404);
  });

  it('creates workspace, api key and source end-to-end', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Shop', slug: `shop-${Date.now()}` }),
    });
    expect(wsRes.status).toBe(201);
    const workspace = (await wsRes.json()) as { id: string };

    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(keyRes.status).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };

    const sourceRes = await app.request('/sources', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'csv',
        name: 'Catalog CSV',
        config: {},
      }),
    });
    expect(sourceRes.status).toBe(201);

    const wrongKeyRes = await app.request('/sources', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dgw_live_invalid_key_value_here_xxxxxxxx',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'csv', name: 'X', config: {} }),
    });
    expect(wrongKeyRes.status).toBe(401);
  });

  it('rejects an API key with empty scopes', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Empty Scopes', slug: `empty-scopes-${Date.now()}`, settings: {} })
      .returning();
    if (!workspace) throw new Error('workspace missing');
    const generated = generateApiKey();

    await db.insert(apiKeys).values({
      workspaceId: workspace.id,
      keyHash: generated.hash,
      prefix: generated.prefix,
      scopes: [],
    });

    const res = await app.request('/sources', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${generated.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'csv', name: 'Blocked', config: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a revoked API key', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Revoked', slug: `revoked-${Date.now()}` }),
    });
    const workspace = (await wsRes.json()) as { id: string };

    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const { id: keyId, key } = (await keyRes.json()) as { id: string; key: string };

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));

    const res = await app.request('/sources', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'csv', name: 'X', config: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('health check responds', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
  });

  it('phase 2 source endpoints return expected status codes', async () => {
    const wsRes = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Phase 2', slug: `phase-2-${Date.now()}` }),
    });
    expect(wsRes.status).toBe(201);
    const workspace = (await wsRes.json()) as { id: string };

    const keyRes = await app.request(`/workspaces/${workspace.id}/api-keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const { key } = (await keyRes.json()) as { key: string };

    const sourceRes = await app.request('/sources', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'csv', name: 'P2 CSV', config: {} }),
    });
    expect(sourceRes.status).toBe(201);
    const source = (await sourceRes.json()) as { id: string };

    const missingProfile = await app.request(`/sources/${source.id}/profile`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(missingProfile.status).toBe(404);

    const indexWithoutMapping = await app.request(`/sources/${source.id}/index`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(indexWithoutMapping.status).toBe(409);

    await db.insert(sourceProfiles).values({
      sourceId: source.id,
      document: {
        totalRecords: 1,
        profiledAt: new Date().toISOString(),
        tables: [
          {
            table: 'csv',
            recordCount: 1,
            columns: [
              {
                name: 'sku',
                inferredType: 'string',
                cardinality: 1,
                nullCount: 0,
                nullRate: 0,
                topValues: [],
              },
            ],
          },
        ],
      },
    });

    const profile = await app.request(`/sources/${source.id}/profile`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(profile.status).toBe(200);

    const invalidMapping = await app.request(`/sources/${source.id}/mapping`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        document: {
          entities: [
            {
              entity: 'product',
              sourceTable: 'csv',
              fields: [
                {
                  name: 'missing',
                  sourceColumn: 'missing',
                  type: 'string',
                  searchable: true,
                  filterable: false,
                  visible: true,
                  sensitive: false,
                },
              ],
              rules: [],
              defaultFilters: [],
              embeddingTextTemplate: '{{missing}}',
            },
          ],
        },
      }),
    });
    expect(invalidMapping.status).toBe(422);
  });

  it('webhook shopify rechaza HMAC inválido y acepta válido', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Webhook WS', slug: `wh-${Date.now()}`, settings: {} })
      .returning();
    if (!workspace) throw new Error('workspace missing');

    const encryptedConfig = encryptSourceConfig(
      'shopify',
      {
        shopDomain: 'hook-shop.myshopify.com',
        accessToken: 'shpat_hook',
        webhookSecret: 'hook-secret',
      },
      ENCRYPTION_KEY,
    );

    await db.insert(sources).values({
      workspaceId: workspace.id,
      type: 'shopify',
      name: 'Hook Shop',
      config: encryptedConfig,
      maturityStatus: 'connected',
    });

    const payload = JSON.stringify({ id: 1 });
    const bad = await app.request('/webhooks/shopify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Shop-Domain': 'hook-shop.myshopify.com',
        'X-Shopify-Topic': 'products/update',
        'X-Shopify-Hmac-Sha256': 'invalid',
        'X-Shopify-Webhook-Id': `wh-bad-${Date.now()}`,
      },
      body: payload,
    });
    expect(bad.status).toBe(401);

    const hmac = computeShopifyHmac(payload, 'hook-secret');
    const ok = await app.request('/webhooks/shopify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Shop-Domain': 'hook-shop.myshopify.com',
        'X-Shopify-Topic': 'products/update',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Webhook-Id': `wh-ok-${Date.now()}`,
      },
      body: payload,
    });
    expect(ok.status).toBe(200);
  });
});

describe.runIf(hasDatabase)('cleanup', () => {
  it('closes db pool', async () => {
    await closeDb();
  });
});
