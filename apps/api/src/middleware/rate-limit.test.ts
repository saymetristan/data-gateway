import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { GatewayError } from '@data-gateway/core';
import { createRateLimiter, resetRateLimitBucketsForTests } from './rate-limit.js';

type Vars = {
  apiKeyId: string;
};

describe('rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimitBucketsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildApp(max: number) {
    const app = new Hono<{ Variables: Vars }>();
    app.use('*', async (c, next) => {
      c.set('apiKeyId', 'key-1');
      await next();
    });
    app.use('*', createRateLimiter({ max, windowMs: 60_000 }));
    app.get('/ping', (c) => c.text('ok'));
    app.onError((error, c) => {
      if (error instanceof GatewayError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    });
    return app;
  }

  it('allows requests under the limit and sets headers', async () => {
    const app = buildApp(2);
    const first = await app.request('/ping');
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('1');
  });

  it('returns 429 when the limit is exceeded', async () => {
    const app = buildApp(1);
    await app.request('/ping');
    const blocked = await app.request('/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('resets the bucket after the window expires', async () => {
    const app = buildApp(1);
    await app.request('/ping');
    const blocked = await app.request('/ping');
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(60_001);
    const allowed = await app.request('/ping');
    expect(allowed.status).toBe(200);
  });
});
