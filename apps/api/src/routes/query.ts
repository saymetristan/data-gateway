import { Hono } from 'hono';
import { executeQuery, GatewayError, queryRequestSchema } from '@data-gateway/core';
import type { AppBindings, AppVariables } from '../app.js';
import { requireScope } from '../middleware/auth.js';

export function queryRoutes(deps: AppBindings) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/', requireScope('query:execute'), async (c) => {
    const body: unknown = await c.req.json();
    const parsed = queryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid query payload', parsed.error.flatten());
    }

    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const apiKeyId = c.get('apiKeyId');

    const response = await executeQuery({
      db,
      workspaceId,
      apiKeyId,
      request: parsed.data,
      embeddingProvider: deps.embeddingProvider,
      llmProvider: deps.llmProvider,
    });

    return c.json(response);
  });

  return routes;
}
