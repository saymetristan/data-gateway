import { describe, it, expect, beforeAll } from 'vitest';
import {
  closeDb,
  createDb,
  MockEmbeddingProvider,
  MockLlmProvider,
  queryLogs,
  runMigrations,
  workspaces,
  type Database,
} from '@data-gateway/core';
import { createApp } from './app.js';
import type { ApiEnv } from './env.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/data_gateway';
const ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');

describe.runIf(hasDatabase)('metrics API integration', () => {
  const adminKey = 'dgw_admin_metrics_test_key_123';
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

  it('returns operational metrics for admin key only', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'Metrics', slug: `metrics-${Date.now()}`, settings: {} })
      .returning();
    if (!workspace) throw new Error('workspace missing');

    await db.insert(queryLogs).values({
      workspaceId: workspace.id,
      rawQuery: 'metrics test',
      structuredQuery: {},
      queryType: 'filter_only',
      appliedFilters: [],
      resultsCount: 1,
      confidence: 0.8,
      latencyMs: 100,
      warnings: [],
    });

    const denied = await app.request('/metrics');
    expect(denied.status).toBe(401);

    const res = await app.request('/metrics', {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: { total: number; latencyMsP50: number | null };
      sync: { sourcesByMaturity: Array<{ maturityStatus: string }> };
    };
    expect(body.query.total).toBeGreaterThanOrEqual(1);
    expect(body.query.latencyMsP50).not.toBeNull();
    expect(body.sync.sourcesByMaturity.length).toBeGreaterThanOrEqual(0);
  });
});

describe.runIf(hasDatabase)('metrics cleanup', () => {
  it('closes db pool', async () => {
    await closeDb();
  });
});
