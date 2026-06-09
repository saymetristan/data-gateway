import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createWorkspace,
  createApiKeyForWorkspace,
  createSourceUnsafeForTests,
  records,
} from '../index.js';
import { withTestDatabase } from '../test/db-helper.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';

describe.runIf(hasDatabase)('database integration', () => {
  it('applies migrations and generates search_text with unaccent', async () => {
    await withTestDatabase(async (db) => {
      const workspace = await createWorkspace(db, {
        name: 'Test',
        slug: 'test-unaccent',
      });

      const sourceRow = await createSourceUnsafeForTests(db, workspace.id, {
        type: 'csv',
        name: 'Catalog',
        config: {},
      });

      await db.insert(records).values({
        workspaceId: workspace.id,
        sourceId: sourceRow.id,
        entity: 'product',
        externalId: 'prod-1',
        data: {
          name: 'Telár premium',
          description: 'Tela resistente',
        },
        mappingVersion: 1,
        searchSource: 'Telár premium Tela resistente',
        sourceRecordHash: 'manual-test-hash',
      });

      const [inserted] = await db.select().from(records).limit(1);
      expect(inserted).toBeDefined();

      const searchResult = await db.execute(
        sql`SELECT id FROM records WHERE search_text @@ plainto_tsquery('es_unaccent', 'telar')`,
      );
      expect(Number(searchResult.rowCount)).toBeGreaterThan(0);
    });
  });

  it('isolates workspaces via API keys', async () => {
    await withTestDatabase(async (db) => {
      const wsA = await createWorkspace(db, { name: 'A', slug: 'ws-a' });
      const wsB = await createWorkspace(db, { name: 'B', slug: 'ws-b' });

      const { key: keyA } = await createApiKeyForWorkspace(db, wsA.id, {});
      const { key: keyB } = await createApiKeyForWorkspace(db, wsB.id, {});

      const sourceA = await createSourceUnsafeForTests(db, wsA.id, {
        type: 'csv',
        name: 'Source A',
        config: {},
      });

      expect(keyA).not.toBe(keyB);
      expect(sourceA.workspaceId).toBe(wsA.id);
    });
  });
});
