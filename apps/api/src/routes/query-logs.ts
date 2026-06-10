import { Hono } from 'hono';
import { GatewayError, listQueryLogs, queryLogsListParamsSchema } from '@data-gateway/core';
import type { AppVariables } from '../app.js';
import { requireScope } from '../middleware/auth.js';

export function queryLogRoutes() {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/', requireScope('logs:read'), async (c) => {
    const db = c.get('db');
    const workspaceId = c.get('workspaceId');
    const parsed = queryLogsListParamsSchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw GatewayError.validation('Invalid query log filters', parsed.error.flatten());
    }

    const response = await listQueryLogs(db, workspaceId, parsed.data);
    return c.json(response);
  });

  return routes;
}
