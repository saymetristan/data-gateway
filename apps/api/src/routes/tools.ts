import { Hono } from 'hono';
import {
  GatewayError,
  getToolManifest,
  invokeTool,
  toolInvokeRequestSchema,
} from '@data-gateway/core';
import type { AppBindings, AppVariables } from '../app.js';
import { requireScope } from '../middleware/auth.js';

export function toolRoutes(deps: AppBindings) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/', requireScope('tools:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const manifest = await getToolManifest(db, workspaceId);
    return c.json(manifest);
  });

  routes.post('/:name/invoke', requireScope('tools:invoke'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const apiKeyId = c.get('apiKeyId');
    const toolName = c.req.param('name');
    if (!toolName) {
      throw GatewayError.validation('Tool name is required');
    }

    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = toolInvokeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw GatewayError.validation('Invalid tool invoke payload', parsed.error.flatten());
    }

    const response = await invokeTool({
      db,
      workspaceId,
      apiKeyId,
      toolName,
      args: parsed.data.args,
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
