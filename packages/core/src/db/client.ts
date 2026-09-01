import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;

// Supabase session pooler limita a 15 conexiones totales; mantener pools chicos.
const DEFAULT_POOL_MAX = 5;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export type CreatePoolOptions = {
  max?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
};

export function createPool(
  connectionString: string,
  options: CreatePoolOptions = {},
): pg.Pool {
  const max = options.max ?? Number(process.env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX);
  const connectionTimeoutMillis =
    options.connectionTimeoutMs ??
    Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS);
  const statementTimeoutMs =
    options.statementTimeoutMs ??
    Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS);

  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis,
    options: `-c statement_timeout=${String(statementTimeoutMs)}`,
  });
}

export function createDbFromPool(targetPool: pg.Pool): Database {
  return drizzle(targetPool, { schema });
}

export function createDb(connectionString: string): Database {
  pool = createPool(connectionString);
  return drizzle(pool, { schema });
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialised. Call createDb() first.');
  }
  return pool;
}

export function getPoolStats(): {
  total: number;
  idle: number;
  waiting: number;
} | null {
  if (!pool) return null;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function pingDb(db: Database): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
