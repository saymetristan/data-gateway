import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, closeDb, runMigrations } from '@data-gateway/core';
import { createApp } from './app.js';
import type { ApiEnv } from './env.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/data_gateway';

describe.runIf(hasDatabase)('API integration', () => {
  const adminKey = 'dgw_admin_test_key_1234567890';
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL);
    const db = createDb(DATABASE_URL);
    const env: ApiEnv = {
      DATABASE_URL,
      PORT: 3000,
      ADMIN_API_KEY: adminKey,
      NODE_ENV: 'test',
    };
    app = createApp({ env, db });
  });

  it('returns 401 without workspace API key on /sources', async () => {
    const res = await app.request('/sources', { method: 'POST' });
    expect(res.status).toBe(401);
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
      body: JSON.stringify({ scopes: [] }),
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
        type: 'database_url',
        name: 'External',
        config: { connectionUrl: 'postgresql://readonly:pass@localhost:5432/catalog' },
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

  it('health check responds', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
  });
});

describe.runIf(hasDatabase)('cleanup', () => {
  it('closes db pool', async () => {
    await closeDb();
  });
});
