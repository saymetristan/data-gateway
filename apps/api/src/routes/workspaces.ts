import { Hono } from 'hono';
import {
  createWorkspace,
  createApiKeyForWorkspace,
  createWorkspaceSchema,
  createApiKeySchema,
} from '@data-gateway/core';
import type { AppVariables } from '../app.js';

export function workspaceRoutes() {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/workspaces', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = createWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      const { GatewayError } = await import('@data-gateway/core');
      throw GatewayError.validation('Invalid workspace payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspace = await createWorkspace(db, parsed.data);

    return c.json(
      {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        settings: workspace.settings,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
      },
      201,
    );
  });

  routes.post('/workspaces/:id/api-keys', async (c) => {
    const workspaceId = c.req.param('id');
    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = createApiKeySchema.safeParse(body);
    if (!parsed.success) {
      const { GatewayError } = await import('@data-gateway/core');
      throw GatewayError.validation('Invalid API key payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const { row, key } = await createApiKeyForWorkspace(db, workspaceId, parsed.data);

    return c.json(
      {
        id: row.id,
        key,
        prefix: row.prefix,
        scopes: row.scopes,
        createdAt: row.createdAt.toISOString(),
      },
      201,
    );
  });

  return routes;
}
