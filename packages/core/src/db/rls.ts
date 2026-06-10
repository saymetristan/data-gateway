import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

export const WORKSPACE_CONTEXT_KEY = 'app.workspace_id';
export const WORKSPACE_RLS_ROLE = 'gateway_app';

export async function setWorkspaceContext(db: Database, workspaceId: string): Promise<void> {
  // postgres en dev tiene BYPASSRLS; gateway_app sí respeta las policies.
  await db.execute(sql`SET LOCAL ROLE ${sql.raw(WORKSPACE_RLS_ROLE)}`);
  await db.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}::text, true)`);
}

export async function withWorkspaceContext<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setWorkspaceContext(tx, workspaceId);
    return fn(tx);
  });
}
