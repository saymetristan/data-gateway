import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createDb,
  closeDb,
  syncDatabaseSource,
  profileSource,
  createSourceMapping,
  indexSource,
  generateEmbeddingsForRecords,
  executeQuery,
  records,
  recordEmbeddings,
  queryLogs,
  sources,
  workspaces,
  MockEmbeddingProvider,
  MockLlmProvider,
  encryptSourceConfig,
} from '../index.js';
import { withTestDatabase } from '../test/db-helper.js';
import type { Database } from '../db/client.js';
import type { MappingDocument } from '../schemas/mapping.js';

const hasFixture =
  process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';
const FIXTURE_URL =
  process.env.FIXTURE_DATABASE_URL ??
  'postgresql://readonly_user:readonly_pass@localhost:5433/catalog';
const ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ??
  Buffer.alloc(32, 7).toString('base64');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(
  path.resolve(__dirname, '../../../../fixtures/ecommerce-seed.sql'),
  'utf8',
);

const phase3Mapping: MappingDocument = {
  entities: [
    {
      entity: 'product',
      sourceTable: 'products',
      fields: [
        { name: 'sku', sourceColumn: 'sku', type: 'string', searchable: true, filterable: true, visible: true, sensitive: false },
        { name: 'name', sourceColumn: 'name', type: 'string', searchable: true, filterable: false, visible: true, sensitive: false },
        { name: 'description', sourceColumn: 'description', type: 'string', searchable: true, filterable: false, visible: true, sensitive: false },
        { name: 'price', sourceColumn: 'price', type: 'number', searchable: false, filterable: true, visible: true, sensitive: false },
        { name: 'stock', sourceColumn: 'stock', type: 'number', searchable: false, filterable: true, visible: true, sensitive: false },
        { name: 'color', sourceColumn: 'color', type: 'string', searchable: false, filterable: true, visible: true, sensitive: false },
        { name: 'size', sourceColumn: 'size', type: 'string', searchable: false, filterable: true, visible: true, sensitive: false },
        { name: 'category', sourceColumn: 'category', type: 'string', searchable: false, filterable: true, visible: true, sensitive: false },
        { name: 'cost', sourceColumn: 'price', type: 'number', searchable: false, filterable: false, visible: true, sensitive: true },
      ],
      rules: [{ field: 'available', op: 'gt', column: 'stock', value: 0 }],
      defaultFilters: [{ field: 'available', op: 'eq', value: true }],
      embeddingTextTemplate: '{{name}} {{sku}} {{description}} {{color}} {{category}}',
    },
  ],
};

async function ensureFixtureSeeded(): Promise<void> {
  const adminUrl = FIXTURE_URL.replace('readonly_user:readonly_pass', 'postgres:postgres');
  const pool = new pg.Pool({ connectionString: adminUrl });
  try {
    await pool.query(seedSql);
  } finally {
    await pool.end();
  }
}

async function bootstrapSource(
  db: Database,
  testUrl: string,
  workspaceId: string,
  withEmbeddings = true,
) {
  const encryptedConfig = encryptSourceConfig(
    'database_url',
    { connectionUrl: FIXTURE_URL, tables: ['products'] },
    ENCRYPTION_KEY,
  );

  const [source] = await db
    .insert(sources)
    .values({
      workspaceId,
      type: 'database_url',
      name: 'Fixture Query',
      config: encryptedConfig,
      maturityStatus: 'connected',
    })
    .returning();
  if (!source) throw new Error('source not created');

  await syncDatabaseSource(db, source.id, workspaceId, ENCRYPTION_KEY, testUrl, { fullSync: true });
  await profileSource(db, source.id);
  const mapping = await createSourceMapping(db, source.id, workspaceId, { document: phase3Mapping });
  await indexSource(db, source.id, workspaceId, testUrl, new MockLlmProvider());

  if (withEmbeddings) {
    const indexedRecords = await db.select().from(records).where(eq(records.sourceId, source.id));
    await generateEmbeddingsForRecords(
      db,
      source.id,
      indexedRecords.map((row) => row.id),
      mapping.version,
      new MockEmbeddingProvider(1024),
    );
  }

  return { source, mapping };
}

describe.runIf(hasFixture)('query integration', () => {
  beforeAll(async () => {
    await ensureFixtureSeeded();
  });

  it('E2E: camiseta roja menos de 100 devuelve filtros y confidence', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Query Shop', slug: `q-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'camiseta rojo menos de 100', limit: 10 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.query_type).toMatch(/hybrid_search|lexical/);
      expect(response.applied_filters).toContainEqual({ field: 'price', op: 'lt', value: 100 });
      expect(response.applied_filters).toContainEqual({ field: 'color', op: 'eq', value: 'rojo' });
      expect(response.confidence).toBeGreaterThan(0);
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0]?.data.cost).toBeUndefined();
    });
  });

  it('aplica default filters aunque el request intente contradecirlos', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Defaults', slug: `d-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: {
          query: 'camiseta roja',
          filters: { available: false },
          limit: 50,
        },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.query_type).toBe('hybrid_search');
      expect(response.applied_filters).toContainEqual({ field: 'available', op: 'eq', value: true });
      for (const result of response.results) {
        expect(Number(result.data.stock)).toBeGreaterThan(0);
      }
    });
  });

  it('encuentra SKU exacto vía trigram', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'SKU', slug: `s-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'SKU-00042', limit: 5 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.results.some((result) => result.data.sku === 'SKU-00042')).toBe(true);
    });
  });

  it('query solo-filtros usa filter_only', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'FilterOnly', slug: `f-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'menos de 200', limit: 10 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.query_type).toBe('filter_only');
      expect(response.applied_filters).toContainEqual({ field: 'price', op: 'lt', value: 200 });
    });
  });

  it('preserva ambos límites de rangos entre X y Y', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Between', slug: `bt-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'entre 50 y 55', limit: 50 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.query_type).toBe('filter_only');
      expect(response.applied_filters).toContainEqual({ field: 'price', op: 'gte', value: 50 });
      expect(response.applied_filters).toContainEqual({ field: 'price', op: 'lte', value: 55 });
      for (const result of response.results) {
        const price = Number(result.data.price);
        expect(price).toBeGreaterThanOrEqual(50);
        expect(price).toBeLessThanOrEqual(55);
      }
    });
  });

  it('ignora filtros del request sobre campos no-filterable/sensitive', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Unsafe Filter', slug: `uf-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      const baseline = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'SKU-00042', limit: 5 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });
      const probed = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: {
          query: 'SKU-00042',
          filters: { cost: 52.99, description: 'Descripcion del producto 42 para catalogo ecommerce en español.' },
          limit: 5,
        },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(probed.results.map((result) => result.id)).toEqual(
        baseline.results.map((result) => result.id),
      );
      expect(probed.applied_filters.some((filter) => filter.field === 'cost')).toBe(false);
      expect(probed.applied_filters.some((filter) => filter.field === 'description')).toBe(false);
      expect(
        probed.warnings.some((warning) => warning.includes('non-filterable field "cost"')),
      ).toBe(true);
      expect(
        probed.warnings.some((warning) => warning.includes('non-filterable field "description"')),
      ).toBe(true);
    });
  });

  it('fuente sin embeddings degrada a lexical con warning', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Lexical', slug: `l-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id, false);

      const response = await executeQuery({
        db,
        workspaceId: workspace.id,
        request: { query: 'camiseta azul', limit: 5 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      expect(response.query_type).toBe('lexical');
      expect(response.warnings.some((warning) => warning.includes('embeddings'))).toBe(true);
      const embeddingCount = await db.select().from(recordEmbeddings);
      expect(embeddingCount).toHaveLength(0);
    });
  });

  it('escribe query_logs por request', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Logs', slug: `log-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      await bootstrapSource(db, testUrl, workspace.id);

      await executeQuery({
        db,
        workspaceId: workspace.id,
        apiKeyId: crypto.randomUUID(),
        request: { query: 'camiseta roja menos de 100', limit: 5 },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      const logs = await db
        .select()
        .from(queryLogs)
        .where(eq(queryLogs.workspaceId, workspace.id));

      expect(logs).toHaveLength(1);
      expect(logs[0]?.latencyMs).toBeGreaterThanOrEqual(0);
      expect(logs[0]?.appliedFilters).toBeTruthy();
      expect(logs[0]?.confidence).toBeGreaterThanOrEqual(0);
      expect(logs[0]?.metadata).toMatchObject({ vectorStrategy: 'ann_first' });
    });
  });

  it('aisla resultados entre workspaces', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspaceA] = await db
        .insert(workspaces)
        .values({ name: 'A', slug: `a-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      const [workspaceB] = await db
        .insert(workspaces)
        .values({ name: 'B', slug: `b-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspaceA || !workspaceB) throw new Error('workspace missing');

      const bootA = await bootstrapSource(db, testUrl, workspaceA.id);
      await bootstrapSource(db, testUrl, workspaceB.id);

      const response = await executeQuery({
        db,
        workspaceId: workspaceA.id,
        request: { query: 'camiseta', limit: 50, sourceId: bootA.source.id },
        embeddingProvider: new MockEmbeddingProvider(1024),
      });

      const resultSourceIds = new Set<string>();
      for (const hit of response.results) {
        const [row] = await db
          .select({ sourceId: records.sourceId, workspaceId: records.workspaceId })
          .from(records)
          .where(eq(records.id, hit.id))
          .limit(1);
        if (row) {
          expect(row.workspaceId).toBe(workspaceA.id);
          resultSourceIds.add(row.sourceId);
        }
      }
      expect(resultSourceIds.has(bootA.source.id)).toBe(true);
    });
  });
});

describe.runIf(hasFixture)('cleanup query integration', () => {
  it('closes shared pools', async () => {
    await closeDb();
  });
});
