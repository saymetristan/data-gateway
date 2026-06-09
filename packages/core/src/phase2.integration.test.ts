import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createDb,
  closeDb,
  createDatabaseConnector,
  syncDatabaseSource,
  profileSource,
  createSourceMapping,
  indexSource,
  generateEmbeddingsForRecords,
  records,
  sourceRecordsRaw,
  recordEmbeddings,
  sources,
  workspaces,
  MockEmbeddingProvider,
  MockLlmProvider,
  encryptSourceConfig,
} from './index.js';
import { withTestDatabase } from './test/db-helper.js';
import type { MappingDocument } from './schemas/mapping.js';
import type { LlmProvider } from './providers/llm.js';

const hasFixture =
  process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const FIXTURE_URL =
  process.env.FIXTURE_DATABASE_URL ??
  'postgresql://readonly_user:readonly_pass@localhost:5433/catalog';
const FIXTURE_WRITE_URL = FIXTURE_URL.replace('readonly_user:readonly_pass', 'write_user:write_pass');
const ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ??
  Buffer.alloc(32, 7).toString('base64');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(
  path.resolve(__dirname, '../../../fixtures/ecommerce-seed.sql'),
  'utf8',
);

async function ensureFixtureSeeded(): Promise<void> {
  const adminUrl = FIXTURE_URL.replace('readonly_user:readonly_pass', 'postgres:postgres');
  const pool = new pg.Pool({ connectionString: adminUrl });
  try {
    await pool.query(seedSql);
  } finally {
    await pool.end();
  }
}

const productMapping: MappingDocument = {
  entities: [
    {
      entity: 'product',
      sourceTable: 'products',
      fields: [
        {
          name: 'sku',
          sourceColumn: 'sku',
          type: 'string',
          searchable: true,
          filterable: true,
          visible: true,
          sensitive: false,
        },
        {
          name: 'name',
          sourceColumn: 'name',
          type: 'string',
          searchable: true,
          filterable: false,
          visible: true,
          sensitive: false,
        },
        {
          name: 'description',
          sourceColumn: 'description',
          type: 'string',
          searchable: true,
          filterable: false,
          visible: true,
          sensitive: false,
        },
        {
          name: 'price',
          sourceColumn: 'price',
          type: 'number',
          searchable: false,
          filterable: true,
          visible: true,
          sensitive: false,
        },
        {
          name: 'stock',
          sourceColumn: 'stock',
          type: 'number',
          searchable: false,
          filterable: true,
          visible: true,
          sensitive: false,
        },
        {
          name: 'category',
          sourceColumn: 'category',
          type: 'string',
          searchable: false,
          filterable: true,
          visible: true,
          sensitive: false,
        },
      ],
      rules: [{ field: 'available', op: 'gt', column: 'stock', value: 0 }],
      defaultFilters: [],
      embeddingTextTemplate: '{{name}} {{sku}} {{description}}',
    },
  ],
};

const productMappingWithEnrichment: MappingDocument = {
  entities: [
    {
      ...productMapping.entities[0]!,
      enrichment: {
        prompt: 'Clasifica este producto: {{description}}',
        inputFields: ['description'],
        outputFields: [{ name: 'semantic_category', type: 'string' }],
      },
    },
  ],
};

class CountingLlmProvider implements LlmProvider {
  readonly model = 'counting-llm';
  calls = 0;

  complete(): Promise<string> {
    this.calls += 1;
    return Promise.resolve(JSON.stringify({ semantic_category: 'ropa' }));
  }
}

describe.runIf(hasFixture)('phase 2 integration', () => {
  beforeAll(async () => {
    await ensureFixtureSeeded();
  });

  it('introspects fixture schema and validates read-only connection', async () => {
    const connector = createDatabaseConnector(FIXTURE_URL);
    try {
      const validation = await connector.validateReadOnlyConnection();
      expect(validation.ok).toBe(true);
      expect(validation.readOnly).toBe(true);

      const schema = await connector.introspectSchema();
      const products = schema.find((table) => table.name === 'products');
      expect(products?.primaryKey).toContain('id');
      expect(products?.columns.some((column) => column.name === 'sku')).toBe(true);
    } finally {
      await connector.close();
    }
  });

  it('rejects write-capable fixture users', async () => {
    const connector = createDatabaseConnector(FIXTURE_WRITE_URL);
    try {
      const validation = await connector.validateReadOnlyConnection();
      expect(validation.ok).toBe(true);
      expect(validation.readOnly).toBe(false);
    } finally {
      await connector.close();
    }
  });

  it('runs sync → profile → mapping → index → embeddings end-to-end', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const slug = `shop-${crypto.randomUUID().slice(0, 8)}`;
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Shop', slug, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace not created');

      const encryptedConfig = encryptSourceConfig(
        'database_url',
        { connectionUrl: FIXTURE_URL, tables: ['products'] },
        ENCRYPTION_KEY,
      );

      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'database_url',
          name: 'Fixture',
          config: encryptedConfig,
          maturityStatus: 'connected',
        })
        .returning();
      if (!source) throw new Error('source not created');
      const sourceId = source.id;
      const workspaceId = workspace.id;

      const syncResult = await syncDatabaseSource(
        db,
        sourceId,
        workspaceId,
        ENCRYPTION_KEY,
        testUrl,
        { fullSync: true },
      );
      expect(syncResult.synced).toBe(300);

      const profile = await profileSource(db, sourceId);
      expect(profile.totalRecords).toBe(300);

      const mapping = await createSourceMapping(db, sourceId, workspaceId, {
        document: productMapping,
      });
      expect(mapping.version).toBe(1);

      const indexResult = await indexSource(
        db,
        sourceId,
        workspaceId,
        testUrl,
        new MockLlmProvider(),
      );
      expect(indexResult.indexed).toBe(300);

      const indexedRecords = await db.select().from(records).where(eq(records.sourceId, sourceId));
      expect(indexedRecords).toHaveLength(300);
      expect(indexedRecords[0]?.searchSource.length).toBeGreaterThan(0);

      const written = await generateEmbeddingsForRecords(
        db,
        sourceId,
        indexedRecords.slice(0, 3).map((row) => row.id),
        mapping.version,
        new MockEmbeddingProvider(1024),
      );
      expect(written).toBe(3);

      const embeddings = await db
        .select()
        .from(recordEmbeddings)
        .where(eq(recordEmbeddings.mappingVersion, mapping.version));
      expect(embeddings.length).toBeGreaterThanOrEqual(3);

      const rawCount = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, sourceId));
      const resync = await syncDatabaseSource(
        db,
        sourceId,
        workspaceId,
        ENCRYPTION_KEY,
        testUrl,
        { fullSync: true },
      );
      expect(resync.synced).toBe(0);
      expect(rawCount).toHaveLength(300);
    });
  });

  it('does not call LLM twice for unchanged enriched records', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const slug = `enrich-${crypto.randomUUID().slice(0, 8)}`;
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Enrich', slug, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace not created');

      const encryptedConfig = encryptSourceConfig(
        'database_url',
        { connectionUrl: FIXTURE_URL, tables: ['products'] },
        ENCRYPTION_KEY,
      );
      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'database_url',
          name: 'Fixture Enrich',
          config: encryptedConfig,
          maturityStatus: 'connected',
        })
        .returning();
      if (!source) throw new Error('source not created');

      await syncDatabaseSource(db, source.id, workspace.id, ENCRYPTION_KEY, testUrl, {
        fullSync: true,
      });
      await profileSource(db, source.id);
      await createSourceMapping(db, source.id, workspace.id, {
        document: productMappingWithEnrichment,
      });

      const provider = new CountingLlmProvider();
      await indexSource(db, source.id, workspace.id, testUrl, provider);
      expect(provider.calls).toBe(300);

      await indexSource(db, source.id, workspace.id, testUrl, provider);
      expect(provider.calls).toBe(300);
    });
  });

  it('incremental sync handles duplicate cursor values without dropping rows', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const slug = `incremental-${crypto.randomUUID().slice(0, 8)}`;
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Incremental', slug, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace not created');

      const encryptedConfig = encryptSourceConfig(
        'database_url',
        { connectionUrl: FIXTURE_URL, tables: ['products'] },
        ENCRYPTION_KEY,
      );
      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'database_url',
          name: 'Fixture Incremental',
          config: encryptedConfig,
          maturityStatus: 'connected',
        })
        .returning();
      if (!source) throw new Error('source not created');

      const firstSync = await syncDatabaseSource(
        db,
        source.id,
        workspace.id,
        ENCRYPTION_KEY,
        testUrl,
        { fullSync: false },
      );
      expect(firstSync.synced).toBe(300);

      const rawRows = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source.id));
      expect(rawRows).toHaveLength(300);
    });
  });
});

describe.runIf(hasFixture)('cleanup phase2', () => {
  it('closes shared pools', async () => {
    await closeDb();
  });
});
