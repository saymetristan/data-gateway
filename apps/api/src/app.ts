import { Hono } from 'hono';
import type { Database, EmbeddingProvider, LlmProvider } from '@data-gateway/core';
import { GatewayError, gatewayErrorToHttp, pingDb } from '@data-gateway/core';
import type { ApiEnv } from './env.js';
import { requestLogger } from './middleware/common.js';
import { adminAuth, workspaceAuth } from './middleware/auth.js';
import { rlsContext } from './middleware/rls.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { healthRoutes } from './routes/health.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { sourceRoutes } from './routes/sources.js';
import { queryRoutes } from './routes/query.js';
import { queryLogRoutes } from './routes/query-logs.js';
import { evalRoutes } from './routes/evals.js';
import { webhookRoutes } from './routes/webhooks.js';
import { toolRoutes } from './routes/tools.js';
import { metricsRoutes } from './routes/metrics.js';

export type AppVariables = {
  db: Database;
  workspaceId: string;
  apiKeyId: string;
  apiKeyScopes: string[];
};

export type AppBindings = {
  env: ApiEnv;
  db: Database;
  embeddingProvider: EmbeddingProvider;
  llmProvider: LlmProvider;
};

function useWorkspaceProtection(
  app: Hono<{ Variables: AppVariables }>,
  paths: string[],
  rateLimiter: ReturnType<typeof createRateLimiter>,
): void {
  for (const path of paths) {
    app.use(path, workspaceAuth());
    app.use(path, rateLimiter);
    app.use(path, rlsContext());
  }
}

export function createApp(deps: AppBindings) {
  const app = new Hono<{ Variables: AppVariables }>();
  const rateLimiter = createRateLimiter({
    max: deps.env.RATE_LIMIT_MAX,
    windowMs: deps.env.RATE_LIMIT_WINDOW_MS,
  });

  app.onError((error, c) => {
    if (error instanceof GatewayError) {
      const { status, body } = gatewayErrorToHttp(error);
      return c.newResponse(JSON.stringify(body), status, {
        'Content-Type': 'application/json',
      });
    }

    console.error('Unhandled error:', error);
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  app.use('*', requestLogger());
  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    await next();
  });

  app.route('/', healthRoutes(deps));

  app.use('/workspaces', adminAuth(deps.env.ADMIN_API_KEY));
  app.use('/workspaces/*', adminAuth(deps.env.ADMIN_API_KEY));
  app.route('/', workspaceRoutes());

  useWorkspaceProtection(app, ['/sources', '/sources/*'], rateLimiter);
  app.route('/sources', sourceRoutes(deps));

  useWorkspaceProtection(app, ['/query', '/query/*'], rateLimiter);
  app.route('/query', queryRoutes(deps));

  useWorkspaceProtection(app, ['/query-logs', '/query-logs/*'], rateLimiter);
  app.route('/query-logs', queryLogRoutes());

  useWorkspaceProtection(app, ['/evals', '/evals/*'], rateLimiter);
  app.route('/evals', evalRoutes(deps));

  useWorkspaceProtection(app, ['/tools', '/tools/*'], rateLimiter);
  app.route('/tools', toolRoutes(deps));

  app.use('/metrics', adminAuth(deps.env.ADMIN_API_KEY));
  app.route('/metrics', metricsRoutes(deps));

  app.route('/webhooks', webhookRoutes(deps));

  return app;
}

export async function checkHealth(db: Database): Promise<{ status: string; db: string }> {
  const ok = await pingDb(db);
  return {
    status: ok ? 'ok' : 'degraded',
    db: ok ? 'connected' : 'disconnected',
  };
}
