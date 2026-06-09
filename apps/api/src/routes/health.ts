import { Hono } from 'hono';
import { checkHealth, type AppBindings } from '../app.js';

export function healthRoutes(deps: AppBindings) {
  const routes = new Hono();

  routes.get('/health', async (c) => {
    const health = await checkHealth(deps.db);
    const status = health.db === 'connected' ? 200 : 503;
    return c.json(health, status);
  });

  return routes;
}
