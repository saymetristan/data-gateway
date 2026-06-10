import { Hono } from 'hono';
import {
  enqueueJob,
  GatewayError,
  isDuplicateWebhook,
  resolveShopifyWebhookSource,
  SHOPIFY_WEBHOOK_JOB,
  verifyShopifyHmac,
} from '@data-gateway/core';
import type { AppBindings } from '../app.js';

export function webhookRoutes(deps: AppBindings) {
  const routes = new Hono();

  routes.post('/shopify', async (c) => {
    const rawBody = await c.req.text();
    const shopDomain = c.req.header('X-Shopify-Shop-Domain');
    const webhookId = c.req.header('X-Shopify-Webhook-Id');
    const topic = c.req.header('X-Shopify-Topic');
    const providedHmac = c.req.header('X-Shopify-Hmac-Sha256');

    if (!shopDomain || !topic) {
      throw GatewayError.validation('Missing Shopify webhook headers');
    }

    const db = deps.db;
    const resolved = await resolveShopifyWebhookSource(
      db,
      shopDomain,
      deps.env.CREDENTIALS_ENCRYPTION_KEY,
    );
    if (!resolved) {
      throw GatewayError.notFound('Shopify source not found for shop domain');
    }

    if (!verifyShopifyHmac(rawBody, providedHmac, resolved.webhookSecret)) {
      throw GatewayError.unauthorized('Invalid Shopify webhook signature');
    }

    if (webhookId && isDuplicateWebhook(webhookId)) {
      return c.json({ status: 'duplicate' });
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const jobId = await enqueueJob(deps.env.DATABASE_URL, SHOPIFY_WEBHOOK_JOB, {
      sourceId: resolved.sourceId,
      workspaceId: resolved.workspaceId,
      topic,
      payload,
    });

    return c.json({ status: 'queued', jobId });
  });

  return routes;
}
