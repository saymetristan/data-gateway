import type { Context, Next } from 'hono';
import { GatewayError, resolveApiKey } from '@data-gateway/core';
import type { AppVariables } from '../app.js';

export function adminAuth(adminApiKey: string) {
  return async (c: Context, next: Next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token || token !== adminApiKey) {
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

    await next();
  };
}
