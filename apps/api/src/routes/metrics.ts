import { Hono } from 'hono';
import { getOperationalMetrics } from '@data-gateway/core';
import type { AppBindings } from '../app.js';

export function metricsRoutes(deps: AppBindings) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const metrics = await getOperationalMetrics(deps.db);
    return c.json(metrics);
  });

  return routes;
}
