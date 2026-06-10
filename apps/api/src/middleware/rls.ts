import type { Context, Next } from 'hono';
import { setWorkspaceContext } from '@data-gateway/core';
import type { AppVariables } from '../app.js';

export function rlsContext() {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const workspaceId = c.get('workspaceId');
    const db = c.get('db');

    return db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      c.set('db', tx);
      await next();
    });
  };
}
