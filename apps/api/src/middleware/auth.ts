import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { GatewayError, resolveApiKey } from '@data-gateway/core';
import type { AppVariables } from '../app.js';

export function adminAuth(adminApiKey: string) {
  return async (c: Context, next: Next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token || !safeEqual(token, adminApiKey)) {
      throw GatewayError.unauthorized('Invalid admin API key');
    }

    await next();
  };
}

export function workspaceAuth() {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw GatewayError.unauthorized('Missing API key');
    }

    const db = c.get('db');
    const apiKey = await resolveApiKey(db, token);

    c.set('workspaceId', apiKey.workspaceId);
    c.set('apiKeyId', apiKey.id);
    c.set('apiKeyScopes', apiKey.scopes);

    await next();
  };
}

export function requireScope(scope: string) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const scopes = c.get('apiKeyScopes');
    if (!scopes.includes(scope) && !scopes.includes('*')) {
      throw GatewayError.unauthorized(`Missing required scope: ${scope}`);
    }

    await next();
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
