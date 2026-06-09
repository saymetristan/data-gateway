import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  closeDb,
  createEvalSet,
  createSourceMapping,
  encryptSourceConfig,
  GatewayError,
  generateEmbeddingsForRecords,
  indexSource,
  MockEmbeddingProvider,
  MockLlmProvider,
  profileSource,
  records,
  runEvalSet,
  seedEvalCasesFromFixture,
  activateSource,
  sourceTransitions,
  sources,
  syncDatabaseSource,
  workspaces,
  evalRuns,
} from './index.js';
import { withTestDatabase } from './test/db-helper.js';
import { seedEcommerceEvalSet } from './test/ecommerce-evals.js';
import type { MappingDocument } from './schemas/mapping.js';

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
  path.resolve(__dirname, '../../../fixtures/ecommerce-seed.sql'),
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

async function bootstrapIndexedSource(
  db: Awaited<ReturnType<typeof withTestDatabase>> extends never ? never : Parameters<Parameters<typeof withTestDatabase>[0]>[0],
  testUrl: string,
  workspaceId: string,
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
      name: 'Fixture Eval',
      config: encryptedConfig,
      maturityStatus: 'connected',
    })
    .returning();
  if (!source) throw new Error('source not created');

  await syncDatabaseSource(db, source.id, workspaceId, ENCRYPTION_KEY, testUrl, { fullSync: true });
  await profileSource(db, source.id);
  const mapping = await createSourceMapping(db, source.id, workspaceId, { document: phase3Mapping });
  await indexSource(db, source.id, workspaceId, testUrl, new MockLlmProvider());

  const indexedRecords = await db.select().from(records).where(eq(records.sourceId, source.id));
  await generateEmbeddingsForRecords(
    db,
    source.id,
    indexedRecords.map((row) => row.id),
    mapping.version,
    new MockEmbeddingProvider(1024),
  );

  return { source, mapping };
}

describe.runIf(hasFixture)('evals integration', () => {
  beforeAll(async () => {
    await ensureFixtureSeeded();
  });

  it('E2E: eval run pasa threshold y promueve fuente a validated', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Eval', slug: `eval-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapIndexedSource(db, testUrl, workspace.id);
      const evalSet = await seedEcommerceEvalSet(db, workspace.id, source.id);

      const [run] = await db
        .insert(evalRuns)
        .values({ evalSetId: evalSet.id, status: 'running', metrics: {} })
        .returning();
      if (!run) throw new Error('run missing');

      await runEvalSet(
        db,
        run.id,
        workspace.id,
        new MockEmbeddingProvider(1024),
        new MockLlmProvider(),
      );

      const [completed] = await db
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.id, run.id))
        .limit(1);
      expect(completed?.status).toBe('completed');
      const metrics = completed?.metrics as { score?: number };
      expect(metrics.score).toBeGreaterThanOrEqual(0.8);

      await runEvalSet(
        db,
        run.id,
        workspace.id,
        new MockEmbeddingProvider(1024),
        new MockLlmProvider(),
      );

      const [updatedSource] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, source.id))
        .limit(1);
      expect(updatedSource?.maturityStatus).toBe('validated');

      const transitions = await db
        .select()
        .from(sourceTransitions)
        .where(eq(sourceTransitions.sourceId, source.id));
      expect(transitions.some((row) => row.toStatus === 'validated')).toBe(true);
      expect(transitions.filter((row) => row.toStatus === 'validated')).toHaveLength(1);
    });
  });

  it('no valida ni activa fuentes cuando un eval run tiene sensitive leaks', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Leaks', slug: `leaks-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapIndexedSource(db, testUrl, workspace.id);
      const evalSet = await createEvalSet(db, workspace.id, {
        name: 'Leaky set',
        sourceId: source.id,
        threshold: 0,
      });
      await seedEvalCasesFromFixture(db, evalSet.id, [
        { query: 'camiseta roja', mustNotContainFields: ['sku'] },
      ]);

      const [run] = await db
        .insert(evalRuns)
        .values({ evalSetId: evalSet.id, status: 'running', metrics: {} })
        .returning();
      if (!run) throw new Error('run missing');

      await runEvalSet(db, run.id, workspace.id, new MockEmbeddingProvider(1024));

      const [completed] = await db
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.id, run.id))
        .limit(1);
      const metrics = completed?.metrics as { score?: number; sensitiveLeaks?: number };
      expect(metrics.score).toBe(0);
      expect(metrics.sensitiveLeaks).toBeGreaterThan(0);

      const [updatedSource] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, source.id))
        .limit(1);
      expect(updatedSource?.maturityStatus).toBe('indexed');

      await db
        .update(sources)
        .set({ maturityStatus: 'validated' })
        .where(eq(sources.id, source.id));
      await expect(activateSource(db, workspace.id, source.id)).rejects.toBeInstanceOf(
        GatewayError,
      );
    });
  });

  it('activate bloquea sin eval run exitoso y permite tras validated', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Gate', slug: `gate-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapIndexedSource(db, testUrl, workspace.id);
      const badSet = await createEvalSet(db, workspace.id, {
        name: 'Bad set',
        sourceId: source.id,
        threshold: 0.99,
      });
      await seedEvalCasesFromFixture(db, badSet.id, [
        { query: 'SKU-IMPOSSIBLE', expectedExternalIds: ['999999'] },
      ]);

      const [badRun] = await db
        .insert(evalRuns)
        .values({ evalSetId: badSet.id, status: 'running', metrics: {} })
        .returning();
      if (!badRun) throw new Error('run missing');

      await runEvalSet(db, badRun.id, workspace.id, new MockEmbeddingProvider(1024));

      await expect(activateSource(db, workspace.id, source.id)).rejects.toBeInstanceOf(
        GatewayError,
      );

      const goodSet = await seedEcommerceEvalSet(db, workspace.id, source.id);
      const [goodRun] = await db
        .insert(evalRuns)
        .values({ evalSetId: goodSet.id, status: 'running', metrics: {} })
        .returning();
      if (!goodRun) throw new Error('run missing');

      await runEvalSet(db, goodRun.id, workspace.id, new MockEmbeddingProvider(1024));
      const activated = await activateSource(db, workspace.id, source.id);
      expect(activated.maturityStatus).toBe('agent_ready');
    });
  });

  it('re-index regresa fuente agent_ready a indexed', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Reindex', slug: `reindex-${crypto.randomUUID().slice(0, 8)}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const { source } = await bootstrapIndexedSource(db, testUrl, workspace.id);
      const evalSet = await seedEcommerceEvalSet(db, workspace.id, source.id);
      const [run] = await db
        .insert(evalRuns)
        .values({ evalSetId: evalSet.id, status: 'running', metrics: {} })
        .returning();
      if (!run) throw new Error('run missing');

      await runEvalSet(db, run.id, workspace.id, new MockEmbeddingProvider(1024));
      await activateSource(db, workspace.id, source.id);

      await indexSource(db, source.id, workspace.id, testUrl, new MockLlmProvider());

      const [updated] = await db
        .select()
        .from(sources)
        .where(eq(sources.id, source.id))
        .limit(1);
      expect(updated?.maturityStatus).toBe('indexed');
    });
  });
});

describe.runIf(hasFixture)('cleanup evals integration', () => {
  it('closes shared pools', async () => {
    await closeDb();
  });
});
