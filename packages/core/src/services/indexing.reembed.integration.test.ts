import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  generateEmbeddingsForRecords,
  indexSource,
  mappings,
  MockEmbeddingProvider,
  MockLlmProvider,
  recordEmbeddings,
  records,
  sourceRecordsRaw,
  sources,
  workspaces,
} from '../index.js';
import { withTestDatabase } from '../test/db-helper.js';

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';

const mappingDocument = {
  entities: [
    {
      entity: 'product',
      sourceTable: 'csv',
      fields: [
        {
          name: 'sku',
          sourceColumn: 'sku',
          type: 'string' as const,
          searchable: true,
          filterable: true,
          visible: true,
          sensitive: false,
        },
      ],
      rules: [],
      defaultFilters: [],
      embeddingTextTemplate: '{{sku}}',
    },
  ],
};

describe.runIf(hasDatabase)('indexing re-embed integration', () => {
  it('queues embeddings for active model when records already exist', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Reembed', slug: `reembed-${Date.now()}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'csv',
          name: 'Reembed Source',
          config: {},
          maturityStatus: 'mapped',
        })
        .returning();
      if (!source) throw new Error('source missing');

      await db.insert(mappings).values({
        sourceId: source.id,
        version: 1,
        document: mappingDocument,
        status: 'active',
      });

      await db.insert(sourceRecordsRaw).values({
        sourceId: source.id,
        sourceRecordId: 'csv:1',
        payload: { sku: 'SKU-1' },
        payloadHash: 'hash-1',
      });

      const providerA = new MockEmbeddingProvider(1024);
      await indexSource(db, source.id, workspace.id, testUrl, new MockLlmProvider(), {
        embeddingModel: providerA.model,
      });
      await generateEmbeddingsForRecords(
        db,
        source.id,
        (
          await db.select({ id: records.id }).from(records).where(eq(records.sourceId, source.id))
        ).map((row) => row.id),
        1,
        providerA,
      );

      const providerB = new (class extends MockEmbeddingProvider {
        override readonly model = 'mock-embedding-b';
      })(1024);

      const result = await indexSource(db, source.id, workspace.id, testUrl, new MockLlmProvider(), {
        embeddingModel: providerB.model,
        invalidateMaturity: false,
      });
      expect(result.embeddingJobs).toBeGreaterThan(0);

      await generateEmbeddingsForRecords(
        db,
        source.id,
        (
          await db.select({ id: records.id }).from(records).where(eq(records.sourceId, source.id))
        ).map((row) => row.id),
        1,
        providerB,
      );

      const embeddings = await db
        .select()
        .from(recordEmbeddings)
        .innerJoin(records, eq(records.id, recordEmbeddings.recordId))
        .where(and(eq(records.sourceId, source.id), eq(recordEmbeddings.embeddingModel, providerB.model)));

      expect(embeddings.length).toBeGreaterThan(0);
    });
  });

  it('purges stale mapping-version embeddings after writing active embeddings', async () => {
    await withTestDatabase(async (db, testUrl) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Mapping Reembed', slug: `mapping-reembed-${Date.now()}`, settings: {} })
        .returning();
      if (!workspace) throw new Error('workspace missing');

      const [source] = await db
        .insert(sources)
        .values({
          workspaceId: workspace.id,
          type: 'csv',
          name: 'Mapping Reembed Source',
          config: {},
          maturityStatus: 'mapped',
        })
        .returning();
      if (!source) throw new Error('source missing');

      await db.insert(mappings).values({
        sourceId: source.id,
        version: 1,
        document: mappingDocument,
        status: 'active',
      });

      await db.insert(sourceRecordsRaw).values({
        sourceId: source.id,
        sourceRecordId: 'csv:1',
        payload: { sku: 'SKU-1' },
        payloadHash: 'hash-1',
      });

      const provider = new MockEmbeddingProvider(1024);
      await indexSource(db, source.id, workspace.id, testUrl, new MockLlmProvider(), {
        embeddingModel: provider.model,
      });

      const [record] = await db
        .select({ id: records.id })
        .from(records)
        .where(eq(records.sourceId, source.id));
      if (!record) throw new Error('record missing');

      await generateEmbeddingsForRecords(db, source.id, [record.id], 1, provider);

      await db
        .update(mappings)
        .set({ status: 'inactive' })
        .where(and(eq(mappings.sourceId, source.id), eq(mappings.version, 1)));

      await db.insert(mappings).values({
        sourceId: source.id,
        version: 2,
        document: mappingDocument,
        status: 'active',
      });

      await indexSource(db, source.id, workspace.id, testUrl, new MockLlmProvider(), {
        embeddingModel: provider.model,
      });
      await generateEmbeddingsForRecords(db, source.id, [record.id], 2, provider);

      const embeddings = await db
        .select({
          mappingVersion: recordEmbeddings.mappingVersion,
        })
        .from(recordEmbeddings)
        .where(eq(recordEmbeddings.recordId, record.id));

      expect(embeddings).toEqual([{ mappingVersion: 2 }]);
    });
  });
});
