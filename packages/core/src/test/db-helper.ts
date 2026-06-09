import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../db/migrate.js';
import { createDb, closeDb, type Database } from '../db/client.js';
import { closeQueue } from '../queue/boss.js';

export const DEFAULT_TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/data_gateway';

export async function withTestDatabase<T>(
  fn: (db: Database, connectionString: string) => Promise<T>,
): Promise<T> {
  const adminUrl = DEFAULT_TEST_DATABASE_URL;
  const dbName = `dg_test_${randomUUID().replace(/-/g, '')}`;
  const adminPool = new pg.Pool({ connectionString: adminUrl });

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  const testUrl = adminUrl.replace(/\/[^/]+$/, `/${dbName}`);
  await runMigrations(testUrl);
  const db = createDb(testUrl);

  try {
    return await fn(db, testUrl);
  } finally {
    await closeQueue().catch(() => undefined);
    await closeDb();
    const dropPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await dropPool.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
    } finally {
      await dropPool.end();
    }
  }
}
