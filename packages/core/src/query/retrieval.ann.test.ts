import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { vectorSearchForSource } from './retrieval.js';

describe('vectorSearchForSource', () => {
  it('builds an ANN-first query and applies scoped filters after the candidate probe', async () => {
    let captured: SQL | undefined;
    const expectedRow = {
      id: 'record-1',
      entity: 'product',
      source_id: 'source-1',
      data: { active: true },
      search_source: 'tornillo grado 5',
      distance: 0.08,
    };
    const db = {
      execute: async (query: SQL) => {
        captured = query;
        return { rows: [expectedRow] };
      },
    } as unknown as Database;

    const rows = await vectorSearchForSource(
      {
        db,
        workspaceId: 'workspace-1',
        entity: 'product',
        filters: [{ field: 'active', op: 'eq', value: true }],
        filterableFields: new Set(['active']),
        embeddingModel: 'test-model',
        mappingVersion: 2,
      },
      'source-1',
      [0.1, 0.2, 0.3],
    );

    expect(rows).toEqual([expectedRow]);
    expect(captured).toBeDefined();

    const compiled = new PgDialect().sqlToQuery(captured as SQL);
    const normalizedSql = compiled.sql.replace(/\s+/g, ' ').trim().toLowerCase();

    expect(normalizedSql).toContain('with hnsw_settings as materialized');
    expect(normalizedSql).toContain('vector_candidates as materialized');
    expect(normalizedSql).toContain('from record_embeddings re');
    expect(normalizedSql).toContain('order by re.embedding <=>');
    expect(normalizedSql).toContain('from vector_candidates vc inner join records r');
    expect(normalizedSql).not.toContain(
      'from records r inner join record_embeddings re',
    );
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        '100',
        '1000',
        '[0.1,0.2,0.3]',
        'test-model',
        2,
        200,
        'workspace-1',
        'source-1',
        'product',
        'true',
        50,
      ]),
    );
    expect(normalizedSql).not.toContain('workspace-1');
    expect(normalizedSql).not.toContain('source-1');
  });
});
