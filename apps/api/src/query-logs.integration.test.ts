import { describe, it, expect, beforeAll } from 'vitest';
import {
  apiKeys,
  closeDb,
  createDb,
  generateApiKey,
  hashApiKey,
  queryLogs,
  runMigrations,
  workspaces,
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

describe.runIf(hasDatabase)('query logs API integration', () => {
  const adminKey = 'dgw_admin_query_logs_test_key';
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

  it('lists logs for the workspace and enforces logs:read scope', async () => {
    const [workspaceA] = await db
      .insert(workspaces)
      .values({ name: 'Logs A', slug: `logs-a-${Date.now()}`, settings: {} })
      .returning();
    const [workspaceB] = await db
      .insert(workspaces)
      .values({ name: 'Logs B', slug: `logs-b-${Date.now()}`, settings: {} })
      .returning();
    if (!workspaceA || !workspaceB) throw new Error('workspaces missing');

    await db.insert(queryLogs).values([
      {
        workspaceId: workspaceA.id,
        rawQuery: 'alpha',
        structuredQuery: { toolName: 'search_variant' },
        queryType: 'filter_only',
        appliedFilters: [],
        resultsCount: 1,
        confidence: 0.4,
        latencyMs: 12,
        warnings: [],
      },
      {
        workspaceId: workspaceB.id,
        rawQuery: 'beta',
        structuredQuery: {},
        queryType: 'lexical',
        appliedFilters: [],
        resultsCount: 0,
        confidence: 0.1,
        latencyMs: 20,
        warnings: [],
        error: 'boom',
      },
    ]);

    const { key: readKey } = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: workspaceA.id,
      keyHash: hashApiKey(readKey),
      prefix: readKey.slice(0, 16),
      scopes: ['logs:read'],
    });

    const { key: deniedKey } = generateApiKey();
    await db.insert(apiKeys).values({
      workspaceId: workspaceA.id,
      keyHash: hashApiKey(deniedKey),
      prefix: deniedKey.slice(0, 16),
      scopes: ['query:execute'],
    });

    const denied = await app.request('/query-logs', {
      headers: { Authorization: `Bearer ${deniedKey}` },
    });
    expect(denied.status).toBe(401);

    const res = await app.request('/query-logs?maxConfidence=0.5&onlyErrors=false', {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: Array<{ rawQuery: string; structuredQuery: Record<string, unknown> }>;
    };
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.rawQuery).toBe('alpha');
    expect(body.logs[0]?.structuredQuery.toolName).toBe('search_variant');
  });
});

describe.runIf(hasDatabase)('query logs cleanup', () => {
  it('closes db pool', async () => {
    await closeDb();
  });
});
