import type { Context, Next } from 'hono';
import { GatewayError } from '@data-gateway/core';
import type { AppVariables } from '../app.js';

export type RateLimitConfig = {
  max: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweepExpired(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function createRateLimiter(config: RateLimitConfig) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    if (config.max <= 0) {
      await next();
      return;
    }

    const apiKeyId = c.get('apiKeyId');
    const now = Date.now();
    sweepExpired(now);

    let bucket = buckets.get(apiKeyId);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.windowMs };
      buckets.set(apiKeyId, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, config.max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    c.header('X-RateLimit-Limit', String(config.max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > config.max) {
      c.header('Retry-After', String(resetSeconds));
      throw GatewayError.rateLimited('API rate limit exceeded');
    }

    await next();
  };
}

export function resetRateLimitBucketsForTests(): void {
  buckets.clear();
  lastSweep = Date.now();
}
