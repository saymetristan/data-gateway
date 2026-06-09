import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, closeDb, getPool } from './client.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSIONS_SQL = readFileSync(
  path.join(packageRoot, 'src/db/sql/extensions.sql'),
  'utf8',
);

export async function runMigrations(connectionString: string): Promise<void> {
  const db = createDb(connectionString);
  const pool = getPool();

  await pool.query(EXTENSIONS_SQL);

  await migrate(db, {
    migrationsFolder: path.join(packageRoot, 'drizzle'),
  });

  await closeDb();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  runMigrations(url)
    .then(() => {
      console.log('Migrations applied');
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
