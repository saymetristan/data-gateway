import { Hono } from 'hono';
import { createSource, createSourceSchema, GatewayError } from '@data-gateway/core';
import type { AppVariables } from '../app.js';

export function sourceRoutes() {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/', async (c) => {
    const body: unknown = await c.req.json();
    const parsed = createSourceSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid source payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const source = await createSource(db, workspaceId, parsed.data);

    return c.json(
      {
        id: source.id,
        workspaceId: source.workspaceId,
        type: source.type,
        name: source.name,
        maturityStatus: source.maturityStatus,
        createdAt: source.createdAt.toISOString(),
        updatedAt: source.updatedAt.toISOString(),
      },
      201,
    );
  });

  return routes;
}
