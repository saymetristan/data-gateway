import { Hono } from 'hono';
import type { Database, EmbeddingProvider, LlmProvider } from '@data-gateway/core';
import { GatewayError, gatewayErrorToHttp, pingDb } from '@data-gateway/core';
import type { ApiEnv } from './env.js';
import { requestLogger } from './middleware/common.js';
import { adminAuth, workspaceAuth } from './middleware/auth.js';
import { healthRoutes } from './routes/health.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { sourceRoutes } from './routes/sources.js';
import { queryRoutes } from './routes/query.js';
import { evalRoutes } from './routes/evals.js';
import { webhookRoutes } from './routes/webhooks.js';

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

export function createApp(deps: AppBindings) {
  const app = new Hono<{ Variables: AppVariables }>();

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

  app.use('/sources', workspaceAuth());
  app.use('/sources/*', workspaceAuth());
  app.route('/sources', sourceRoutes(deps));

  app.use('/query', workspaceAuth());
  app.use('/query/*', workspaceAuth());
  app.route('/query', queryRoutes(deps));

  app.use('/evals', workspaceAuth());
  app.use('/evals/*', workspaceAuth());
  app.route('/evals', evalRoutes(deps));

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
