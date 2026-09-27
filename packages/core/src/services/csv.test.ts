import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../db/client.js';
import { records, sources, sourceRecordsRaw, workspaces } from '../db/schema/index.js';
import { enqueueJob } from '../queue/boss.js';
import { withTestDatabase } from '../test/db-helper.js';
import { payloadHash } from '../utils/hash.js';
import { buildCsvFallbackPrimaryKey, ingestCsvUpload } from './csv.js';

vi.mock('../queue/boss.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue('profile-job'),
  closeQueue: vi.fn().mockResolvedValue(undefined),
}));

describe('csv ingestion helpers', () => {
  it('builds stable fallback ids independent of row order', () => {
    const row = { name: 'Camisa', price: '12.50' };

    expect(buildCsvFallbackPrimaryKey(row)).toBe(buildCsvFallbackPrimaryKey({ ...row }));
    expect(buildCsvFallbackPrimaryKey(row)).toMatch(/^row:[a-f0-9]{16}$/);
  });

  it('keeps duplicate SKUs distinct when row content differs', () => {
    const first = buildCsvFallbackPrimaryKey({ sku: 'SKU-1', name: 'Small' });
    const second = buildCsvFallbackPrimaryKey({ sku: 'SKU-1', name: 'Large' });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^SKU-1:[a-f0-9]{16}$/);
  });
});

const hasDatabase = process.env.RUN_INTEGRATION_TESTS === 'true' || process.env.CI === 'true';

describe.runIf(hasDatabase)('CSV database batches', () => {
  it('preserves hashes, unchanged timestamps, duplicate transitions and source isolation', async () => {
    await withTestDatabase(async (db, url) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'CSV', slug: 'csv' })
        .returning();
      const [source, other] = await db
        .insert(sources)
        .values([
          { workspaceId: workspace!.id, type: 'csv', name: 'CSV' },
          { workspaceId: workspace!.id, type: 'csv', name: 'Other' },
        ])
        .returning();
      const upload = (csv: string) => ingestCsvUpload(db, source!.id, workspace!.id, csv, url);
      expect(await upload('id,name\na,First\nb,Keep')).toEqual({ imported: 2 });
      await db.insert(records).values(
        ['a', 'b'].map((externalId) => ({
          workspaceId: workspace!.id,
          sourceId: source!.id,
          entity: 'product',
          externalId,
        })),
      );
      await ingestCsvUpload(db, other!.id, workspace!.id, 'id,name\na,Other', url);
      const before = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source!.id));
      expect(await upload('id,name\nb,Keep\na,First')).toEqual({ imported: 0 });
      expect(await db.select().from(records)).toHaveLength(2);
      expect(
        await db.select().from(sourceRecordsRaw).where(eq(sourceRecordsRaw.sourceId, source!.id)),
      ).toEqual(before);
      // A -> B -> A still counted and written by the original serial writer.
      expect(await upload('id,name\na,First\na,Changed\na,Changed\na,First\nb,Keep')).toEqual({
        imported: 2,
      });
      const after = await db
        .select()
        .from(sourceRecordsRaw)
        .where(eq(sourceRecordsRaw.sourceId, source!.id));
      const first = after.find((row) => row.sourceRecordId === 'csv:a')!;
      expect(first.payload).toEqual({ id: 'a', name: 'First', __table: 'csv' });
      expect(first.payloadHash).toBe(payloadHash(first.payload));
      expect(first.id).toBe(before.find((row) => row.sourceRecordId === 'csv:a')!.id);
      expect(first.createdAt).toEqual(
        before.find((row) => row.sourceRecordId === 'csv:a')!.createdAt,
      );
      expect(first.syncedAt.getTime()).toBeGreaterThan(
        before.find((row) => row.sourceRecordId === 'csv:a')!.syncedAt.getTime(),
      );
      expect(after.find((row) => row.sourceRecordId === 'csv:b')).toEqual(
        before.find((row) => row.sourceRecordId === 'csv:b'),
      );
      await expect(
        ingestCsvUpload(db, source!.id, randomUUID(), 'id,name\na,Forbidden', url),
      ).rejects.toThrow();
      expect(await upload('id,name\na,Final\na,Final')).toEqual({ imported: 1 });
      const all = await db.select().from(sourceRecordsRaw);
      expect(all).toHaveLength(2);
      expect(all.find((row) => row.sourceId === other!.id)!.payload).toEqual({
        id: 'a',
        name: 'Other',
        __table: 'csv',
      });
      expect(all.find((row) => row.sourceId === source!.id)!.payload).toEqual({
        id: 'a',
        name: 'Final',
        __table: 'csv',
      });
      expect((await db.select().from(records)).map((row) => row.externalId)).toEqual(['a']);
      expect(await upload('id,name\n')).toEqual({ imported: 0 });
      expect(await db.select().from(records)).toHaveLength(0);
      expect((await db.select().from(sourceRecordsRaw)).map((row) => row.sourceId)).toEqual([
        other!.id,
      ]);
    });
  });

  it('writes 39,796 changed rows in 80 statements and retains unchanged rows', async () => {
    await withTestDatabase(async (db, url) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'CSV', slug: 'csv' })
        .returning();
      const [source] = await db
        .insert(sources)
        .values({ workspaceId: workspace!.id, type: 'csv', name: 'CSV' })
        .returning();
      const csv = (suffix: string) =>
        'id,name\n' +
        Array.from({ length: 39_796 }, (_, i) => `${i},Item ${i}${suffix}`).join('\n');
      const upload = (content: string) =>
        ingestCsvUpload(db, source!.id, workspace!.id, content, url);
      expect(await upload(csv(''))).toEqual({ imported: 39_796 });
      const query = vi.spyOn(getPool(), 'query');
      try {
        expect(await upload(csv(' changed'))).toEqual({ imported: 39_796 });
        const statements = query.mock.calls.map(([config]) =>
          typeof config === 'string' ? config : (config as { text: string }).text,
        );
        expect(
          statements.filter((text) => text.startsWith('insert into "source_records_raw"')),
        ).toHaveLength(80);
        expect(
          statements.filter(
            (text) => text.startsWith('select') && text.includes('from "source_records_raw"'),
          ),
        ).toHaveLength(2);
      } finally {
        query.mockRestore();
      }
      expect(await upload(csv(' changed'))).toEqual({ imported: 0 });
      const rows = await db.select().from(sourceRecordsRaw);
      expect(rows).toHaveLength(39_796);
      expect(rows.every((row) => row.payloadHash === payloadHash(row.payload))).toBe(true);
      expect(new Set(rows.map((row) => row.sourceRecordId)).size).toBe(39_796);
    });
  }, 60_000);

  it('does not delete stale raw or indexed records or schedule profiling after a batch fails', async () => {
    await withTestDatabase(async (db, url) => {
      const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'CSV', slug: 'csv' })
        .returning();
      const [source] = await db
        .insert(sources)
        .values({ workspaceId: workspace!.id, type: 'csv', name: 'CSV' })
        .returning();
      await ingestCsvUpload(
        db,
        source!.id,
        workspace!.id,
        'id,name\nstale,Keep until success',
        url,
      );
      await db.insert(records).values({
        workspaceId: workspace!.id,
        sourceId: source!.id,
        entity: 'product',
        externalId: 'stale',
      });
      const [before] = await db.select().from(sources).where(eq(sources.id, source!.id));
      await db.execute(
        sql`ALTER TABLE source_records_raw ADD CONSTRAINT reject_bad CHECK (payload->>'id' <> 'bad')`,
      );
      const queuedBefore = vi.mocked(enqueueJob).mock.calls.length;
      const csv =
        'id,name\n' +
        Array.from({ length: 500 }, (_, i) => `${i},Good`).join('\n') +
        '\nbad,Rejected';
      await expect(ingestCsvUpload(db, source!.id, workspace!.id, csv, url)).rejects.toThrow();
      const rows = await db.select().from(sourceRecordsRaw);
      expect(rows).toHaveLength(501); // The first batch persisted; cleanup did not run.
      expect(rows.some((row) => row.sourceRecordId === 'csv:stale')).toBe(true);
      expect(await db.select().from(records)).toHaveLength(1);
      expect(await db.select().from(sources).where(eq(sources.id, source!.id))).toEqual([before]);
      expect(vi.mocked(enqueueJob).mock.calls).toHaveLength(queuedBefore);
    });
  });
});
