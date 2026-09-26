import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { Database } from '../db/client.js';
import { resolveLexicalFusionWeight } from '../services/query.js';
import { buildLexicalBranches } from './lexical-branches.js';
import {
  fuseLexicalAndVector,
  lexicalSearchMultiBranch,
  lexicalSearchSingle,
  selectLexicalBranches,
  type RawRecordRow,
  type RetrievalScope,
} from './retrieval.js';
import { reciprocalRankFusion } from './rrf.js';

describe('selectLexicalBranches', () => {
  it('keeps the full branch and highest-weight distinctive/synonym branches', () => {
    const branches = buildLexicalBranches(
      'tela para bordar punto de cruz, Aida o canevá, manualidades',
      { aida: ['cuadrille aida', 'cuadrille'], caneva: ['etamina'] },
    );
    const selected = selectLexicalBranches(branches);
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.some((branch) => branch.kind === 'full')).toBe(true);
    expect(selected.some((branch) => /aida/i.test(branch.text))).toBe(true);
  });

  it('reserves branch budget for identifier-like policy aliases', () => {
    const branches = buildLexicalBranches(
      'aceite Mobil tapa amarilla cubeta 19 litros',
      {
        '19 litros': ['19 lts', '19l', '120035', 'MX15W40', '1300'],
      },
    );
    const selected = selectLexicalBranches(branches);
    const selectedTexts = selected.map((branch) => branch.text);

    expect(selected).toHaveLength(6);
    expect(selectedTexts).toEqual(
      expect.arrayContaining(['MX15W40', '120035', '1300']),
    );
  });
});

describe('multi-branch RRF preference for distinctive hits', () => {
  it('lets a distinctive-term ranking outrank a weak full-phrase empty/error path', () => {
    // Full phrase matched nothing; distinctive "Aida" matched catalog rows.
    const fused = reciprocalRankFusion([
      { ids: [], weight: 1 },
      { ids: ['aida-1', 'aida-2'], weight: 1.5 },
      { ids: ['aros-1', 'navidad-1'], weight: 1.1 },
    ]);
    expect(fused[0]?.id).toBe('aida-1');
  });

  it('boosts lexical fusion weight when distinctive terms hit', () => {
    const boosted = resolveLexicalFusionWeight(
      1,
      [{ search_source: 'Cuadrille Aida Blanco' }],
      ['Aida'],
    );
    expect(boosted).toBeGreaterThanOrEqual(1.45);

    const plain = resolveLexicalFusionWeight(
      1,
      [{ search_source: 'Algodón Navidad Digital' }],
      ['Aida'],
    );
    expect(plain).toBe(1);
  });

  it('keeps an exact identifier match ahead of vector neighbors', () => {
    const result = fuseLexicalAndVector({
      lexicalRows: [
        {
          id: 'exact',
          entity: 'product',
          source_id: 'source-1',
          data: { sku: 'FF-213' },
          search_source: 'Filtro FF-213',
          identifier_match: true,
        },
      ],
      vectorRows: [
        {
          id: 'semantic',
          entity: 'product',
          source_id: 'source-1',
          data: { sku: 'OTHER' },
          search_source: 'Filtro semánticamente cercano',
          distance: 0.01,
        },
      ],
      limit: 5,
    });

    expect(result.hits[0]?.id).toBe('exact');
    expect(result.hits[0]?.score).toBe(1);
  });
});


describe('complete literal matches through fusion', () => {
  it('preserves weak exact hits before the fusion limit without changing RRF scores', () => {
    const rows: RawRecordRow[] = Array.from({ length: 60 }, (_, index) => ({
      id: `variant-${index}`, entity: 'product', source_id: 'source',
      data: {}, search_source: 'Dill Fresh',
    }));
    rows.push(
      { ...rows[0]!, id: 'normalized', search_source: 'DILL', exact_search_match: 1 },
      { ...rows[0]!, id: 'literal', search_source: 'Dill', exact_search_match: 2 },
      { ...rows[0]!, id: 'identifier', identifier_match: true },
    );
    const vectorRows = rows.slice(0, 60).map((row) => ({ ...row, distance: 0.01 }));
    const result = fuseLexicalAndVector({ lexicalRows: rows, vectorRows, limit: 30 });
    const baseline = fuseLexicalAndVector({
      lexicalRows: rows.map(({ exact_search_match: _priority, ...row }) => row),
      vectorRows, limit: 100,
    });
    expect(result.hits.slice(0, 3).map((hit) => hit.id)).toEqual([
      'identifier', 'literal', 'normalized',
    ]);
    expect(result.hits).toHaveLength(30);
    for (const hit of result.hits) {
      expect(hit.score).toBe(baseline.hits.find((item) => item.id === hit.id)?.score);
    }
    expect(result.hits[1]?.exactSearchMatch).toBe(2);
    expect(result.hits[2]?.exactSearchMatch).toBe(1);
  });

  it('keeps non-exact fusion order and scores unchanged', () => {
    const rows = ['first', 'second', 'third'].map((id) => ({
      id, entity: 'product', source_id: 'source', data: {}, search_source: id,
    }));
    const baseline = fuseLexicalAndVector({ lexicalRows: rows, vectorRows: [], limit: 5 });
    const explicitZero = fuseLexicalAndVector({
      lexicalRows: rows.map((row) => ({ ...row, exact_search_match: 0 })),
      vectorRows: [], limit: 5,
    });
    expect(explicitZero).toEqual(baseline);
  });
});

// Opt-in focused SQL fixture: uses a disposable local PostgreSQL database with
// the existing es_unaccent configuration, without pgvector or full migrations.
const exactSearchDatabaseUrl = process.env.EXACT_SEARCH_TEST_DATABASE_URL;
describe.skipIf(!exactSearchDatabaseUrl)('literal ranking with PostgreSQL', () => {
  let client: pg.Client;
  let lastQuery: { sql: string; params: unknown[] };
  let scope: RetrievalScope;

  beforeAll(async () => {
    const url = new URL(exactSearchDatabaseUrl!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Exact-search SQL fixtures require a local disposable database');
    }
    client = new pg.Client({ connectionString: exactSearchDatabaseUrl });
    await client.connect();
    await client.query(`CREATE TEMP TABLE records (
      id text, workspace_id text, source_id text, entity text, data jsonb,
      search_source text, search_text tsvector, updated_at timestamptz
    )`);
    await client.query('CREATE INDEX ON records USING gin(search_text)');
    const db = { execute: async (query: SQL) => {
      lastQuery = new PgDialect().sqlToQuery(query);
      return client.query(lastQuery.sql, lastQuery.params);
    } } as unknown as Database;
    scope = {
      db, workspaceId: 'workspace', sourceIds: ['source'], entity: 'product',
      filters: [
        { field: 'port', op: 'eq', value: 'PORT' },
        { field: 'version', op: 'eq', value: 'current' },
      ],
      filterableFields: new Set(['port', 'version']), freeText: '', limit: 5,
    };
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => { await client.query('TRUNCATE records'); });

  async function insert(
    id: string, text: string,
    overrides: { workspace?: string; source?: string; entity?: string; port?: string; version?: string } = {},
  ) {
    await client.query(`INSERT INTO records VALUES ($1,$2,$3,$4,$5,$6,
      to_tsvector('es_unaccent', public.f_unaccent($6)), '2026-01-01')`, [
      id, overrides.workspace ?? 'workspace', overrides.source ?? 'source',
      overrides.entity ?? 'product',
      JSON.stringify({ port: overrides.port ?? 'PORT', version: overrides.version ?? 'current' }), text,
    ]);
  }

  it.each([
    ['ONIONS DRY', 'Dry Onions'],
    ['Chayote (Sayote)', 'Chayote'],
    ['YOGHURT YOGHURT PLAIN 5KG/TIN', 'YOGHURT YOGHURT PLAIN 5KG/TIN - GREEK STYLE'],
    ['CAYENNE PEPPER', 'PEPPER YELLOW'],
    ['CUCUMBER PICKLED', 'PICKLED CUCUMBERS - WHOLE, NET WEIGHT'],
    ['Dill', 'DILL'],
  ])('keeps %s ahead of variants before LIMIT 50', async (query, variant) => {
    scope.freeText = query;
    await insert('literal', query);
    await insert('observed-variant', variant);
    for (let i = 0; i < 60; i++) {
      await insert(`crowded-${i}`, `${query} ${query} variant`);
    }
    const rows = await lexicalSearchSingle(scope, query);
    const baseline = await client.query(lastQuery.sql.replace(
      'ORDER BY exact_search_match DESC, rank DESC', 'ORDER BY rank DESC',
    ), lastQuery.params);
    expect(baseline.rows.some((row) => row.id === 'literal')).toBe(false);
    expect(rows).toHaveLength(50);
    expect(rows[0]?.id).toBe('literal');
    expect(rows[0]?.exact_search_match).toBe(2);
    const result = fuseLexicalAndVector({
      lexicalRows: rows, vectorRows: rows.slice(1).map((row) => ({ ...row, distance: 0.01 })), limit: 5,
    });
    expect(result.hits[0]?.id).toBe('literal');
  });

  it('ranks literal before normalized text and preserves every scope constraint', async () => {
    scope.freeText = 'Dill';
    await insert('literal', 'Dill');
    await insert('normalized', '  DÍLL  ');
    for (let i = 0; i < 60; i++) await insert(`upper-${i}`, 'DILL');
    for (const dimension of ['workspace', 'source', 'entity', 'port', 'version']) {
      await insert(`outside-${dimension}`, 'Dill', { [dimension]: 'other' });
    }
    const rows = await lexicalSearchSingle(scope, 'Dill');
    expect(rows[0]?.id).toBe('literal');
    expect(rows.slice(1).every((row) => row.exact_search_match === 1)).toBe(true);
    expect(rows.some((row) => row.id.startsWith('outside-'))).toBe(false);
    expect(lastQuery.sql).not.toContain("= 'workspace'");
  });

  it('keeps the existing GIN plan available for full-text queries', async () => {
    scope.freeText = 'CAYENNE PEPPER';
    await insert('literal', scope.freeText);
    await lexicalSearchSingle(scope, scope.freeText);
    // Prove the existing GIN predicate remains eligible; tiny fixture tables
    // normally favor a sequential scan regardless of the production query.
    await client.query('SET enable_seqscan = off');
    try {
      const plan = await client.query(`EXPLAIN ${lastQuery.sql}`, lastQuery.params);
      const explanation = plan.rows.map((row) => row['QUERY PLAN']).join(' ');
      expect(explanation).toContain('Bitmap Index Scan');
      expect(explanation).toContain('search_text @@');
    } finally {
      await client.query('RESET enable_seqscan');
    }
  });

  it('uses the complete query for every branch and preserves non-exact SQL order', async () => {
    scope.freeText = 'CAYENNE PEPPER';
    await insert('literal', 'CAYENNE PEPPER');
    await insert('branch-only', 'PEPPER');
    for (let i = 0; i < 60; i++) await insert(`pepper-${i}`, 'PEPPER PEPPER RED');
    const rows = await lexicalSearchMultiBranch(scope, [
      { text: 'CAYENNE PEPPER', kind: 'full', weight: 1 },
      { text: 'PEPPER', kind: 'distinctive', weight: 2 },
    ]);
    expect(rows[0]?.id).toBe('literal');
    expect(rows.find((row) => row.id === 'branch-only')?.exact_search_match ?? 0).toBe(0);
    scope.freeText = 'RED';
    const nonExact = await lexicalSearchSingle(scope, 'RED');
    const baseline = await client.query(lastQuery.sql.replace(
      'ORDER BY exact_search_match DESC, rank DESC', 'ORDER BY rank DESC',
    ), lastQuery.params);
    expect(nonExact).toEqual(baseline.rows);
    expect(nonExact.every((row) => row.exact_search_match === 0)).toBe(true);
  });
});
