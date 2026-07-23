import { Hono } from 'hono';
import {
  executeQuery,
  GatewayError,
  getQueryCapabilities,
  queryRequestSchema,
} from '@data-gateway/core';
import type { AppBindings, AppVariables } from '../app.js';
import { requireScope } from '../middleware/auth.js';

export function queryRoutes(deps: AppBindings) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/capabilities', requireScope('query:execute'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const entity = c.req.query('entity')?.trim() || undefined;
    const sourceId = c.req.query('sourceId')?.trim() || undefined;

    if (sourceId) {
      const uuidCheck =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidCheck.test(sourceId)) {
        throw GatewayError.validation('Invalid sourceId query parameter');
      }
    }

    const capabilities = await getQueryCapabilities({
      db,
      workspaceId,
      ...(entity ? { entity } : {}),
      ...(sourceId ? { sourceId } : {}),
    });
    return c.json(capabilities);
  });

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
      softDeadlineMs: deps.env.EMBEDDING_SOFT_DEADLINE_MS,
      hardTimeoutMs: deps.env.EMBEDDING_HARD_TIMEOUT_MS,
      enableSynonymExpansion: deps.env.ENABLE_QUERY_SYNONYM_EXPANSION,
    });

    return c.json(response);
  });

  return routes;
}
