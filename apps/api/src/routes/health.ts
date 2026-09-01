import { Hono } from 'hono';
import { checkHealth, checkReadiness, type AppBindings } from '../app.js';

export function healthRoutes(deps: AppBindings) {
  const routes = new Hono();

  routes.get('/health', async (c) => {
    const health = await checkHealth(deps.db);
    const status = health.db === 'connected' ? 200 : 503;
    return c.json(health, status);
  });

  routes.get('/ready', async (c) => {
    const readiness = await checkReadiness(deps.db);
    return c.json(readiness, readiness.status === 'ready' ? 200 : 503);
  });

  return routes;
}
