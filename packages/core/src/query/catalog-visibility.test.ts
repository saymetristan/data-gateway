import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import { buildCatalogVisibilityCondition, NR_ITEM_NAME_PATTERN } from './catalog-visibility.js';
import {
  hybridSearch,
  lexicalSearch,
  vectorSearchForSource,
  type HybridSearchInput,
} from './retrieval.js';
import { buildPreferenceCandidateFilterSets } from './preference-candidates.js';
import { buildRelaxedRetrievalState } from './relax-filters.js';

const dialect = new PgDialect();

describe('catalog visibility SQL', () => {
  it('applies the server rule inside the ANN probe before its limit and after the join', async () => {
    let captured: SQL | undefined;
    const db = {
      execute: async (query: SQL) => {
        captured = query;
        return { rows: [] };
      },
    } as unknown as Database;
    await vectorSearchForSource(
      {
        db,
        workspaceId: 'tenant',
        entity: 'product',
        filters: [],
        filterableFields: new Set(),
        embeddingModel: 'model',
        mappingVersion: 9,
      },
      'source',
      [0.1],
    );
    const compiled = dialect.sqlToQuery(captured!);
    const probe = compiled.sql.slice(
      compiled.sql.indexOf('FROM record_embeddings re'),
      compiled.sql.indexOf(') candidate'),
    );
    expect(probe.indexOf('visibility_workspace.slug')).toBeGreaterThan(0);
    expect(probe.indexOf('visibility_workspace.slug')).toBeLessThan(probe.indexOf('LIMIT'));
    expect(probe).toContain('r.workspace_id <>');
    expect(compiled.sql).toContain('r.source_id =');
    expect(compiled.sql.match(/visibility_workspace.slug/g)).toHaveLength(2);
    expect(compiled.params).toContain(NR_ITEM_NAME_PATTERN);
    expect(compiled.params).toContain('tractodiesel');
    expect(compiled.sql).not.toContain('tractodiesel');
  });
});

// Explicit opt-in to a disposable local PostgreSQL, never DATABASE_URL.
const localUrl = process.env.NR_TEST_DATABASE_URL;
describe.runIf(Boolean(localUrl))('catalog visibility PostgreSQL', () => {
  let client: pg.Client;
  let db: Database;
  const schema = `nr_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const tenant = '00000000-0000-0000-0000-000000000001';
  const otherTenant = '00000000-0000-0000-0000-000000000002';
  const source = '00000000-0000-0000-0000-000000000003';
  const otherSource = '00000000-0000-0000-0000-000000000004';
  const names = [
    'N.R. BOCAFLECHA',
    'N.R.BOCAFLECHA',
    ' n.r BOCAFLECHA',
    'N.R',
    '\tN.R. X',
    '\u00a0N.R. X',
    'NR BOCAFLECHA',
    'N.RACING',
    'BOCAFLECHA N.R.',
    'BOCAFLECHA',
    null,
  ];
  const expected = names
    .map((name, index) => ({ name, id: `p${index}` }))
    .filter(({ name }) => typeof name !== 'string' || !/^\s*N\.R(?:\.|\s|$)/i.test(name))
    .map(({ id }) => id);

  beforeAll(async () => {
    const url = new URL(localUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('NR tests require local PostgreSQL');
    client = new pg.Client({ connectionString: localUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE TEXT SEARCH CONFIGURATION ${schema}.es_unaccent (COPY = pg_catalog.simple);
      CREATE TABLE workspaces (id uuid PRIMARY KEY, slug text);
      CREATE TABLE records (id text PRIMARY KEY, workspace_id uuid, source_id uuid, entity text,
        data jsonb, search_source text, search_text tsvector, updated_at timestamptz);
    `);
    await client.query(
      `CREATE OR REPLACE FUNCTION ${schema}.f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1'`,
    );
    // Retrieval qualifies f_unaccent as public; use a SQL adapter so the fixture stays isolated.
    db = {
      execute: async (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        return client.query(
          compiled.sql.replaceAll('public.f_unaccent', `${schema}.f_unaccent`),
          compiled.params,
        );
      },
    } as unknown as Database;
    await client.query('INSERT INTO workspaces VALUES ($1, $2), ($3, $4)', [
      tenant,
      'tractodiesel',
      otherTenant,
      'other',
    ]);
    async function insert(
      id: string,
      workspace: string,
      src: string,
      entity: string,
      data: object,
    ) {
      await client.query(
        `INSERT INTO records VALUES ($1,$2,$3,$4,$5,'BOCAFLECHA',to_tsvector('simple','BOCAFLECHA'),now())`,
        [id, workspace, src, entity, data],
      );
    }
    for (const [index, name] of names.entries()) {
      await insert(`p${index}`, tenant, source, 'product', {
        item_name: name,
        item_code: `SKU${index}`,
        marca: 'wanted',
      });
      await insert(`i${index}`, tenant, source, 'inventory', {
        item_code: `SKU${index}`,
        available: true,
      });
      await insert(`o${index}`, otherTenant, source, 'product', {
        item_name: name,
        item_code: `SKU${index}`,
      });
    }
    await insert('other-source-inventory', tenant, otherSource, 'inventory', { item_code: 'SKU0' });
    await insert('other-entity', tenant, source, 'customer', { item_name: 'N.R. CUSTOMER' });
    await insert('missing-sku', tenant, source, 'inventory', { available: true });
    // Excluded products would fill every small result limit without the SQL rule.
    await client.query(
      "UPDATE records SET updated_at = now() + interval '1 day' WHERE id = ANY($1)",
      [names.map((_, index) => `p${index}`).filter((id) => !expected.includes(id))],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });

  function input(entity?: string, workspaceId = tenant): HybridSearchInput {
    return {
      db,
      workspaceId,
      sourceIds: [source],
      ...(entity ? { entity } : {}),
      mappingVersionBySource: new Map(),
      embeddingModel: 'test',
      filters: [],
      freeText: '',
      limit: 50,
      filterableFields: new Set(['item_code', 'marca', 'available']),
      embeddingsAvailableBySource: new Map(),
    };
  }

  it('matches the authorized JS expression, preserving tenant and entity isolation', async () => {
    const products = await hybridSearch(input('product'));
    expect(products.hits.map((hit) => hit.id).sort()).toEqual([...expected].sort());
    expect((await hybridSearch(input('product', otherTenant))).hits).toHaveLength(names.length);
    expect((await hybridSearch(input('customer'))).hits.map((hit) => hit.id)).toEqual([
      'other-entity',
    ]);
    const inventories = await hybridSearch(input('inventory'));
    expect(inventories.hits.map((hit) => hit.id).sort()).toEqual(
      [...expected.map((id) => id.replace('p', 'i')), 'missing-sku'].sort(),
    );
    const crossSource = await hybridSearch({ ...input('inventory'), sourceIds: [otherSource] });
    expect(crossSource.hits.map((hit) => hit.id)).toEqual(['other-source-inventory']);
  });

  it('excludes before filter-only limits, lexical branches and exact SKU lookup', async () => {
    const first = await hybridSearch({ ...input('product'), limit: 1 });
    expect(expected).toContain(first.hits[0]?.id);
    const scope = {
      ...input('product'),
      freeText: 'BOCAFLECHA',
      lexicalBranches: [
        { text: 'BOCAFLECHA', kind: 'full' as const, weight: 1 },
        { text: 'BOCAFLECHA', kind: 'distinctive' as const, weight: 1 },
      ],
    };
    expect((await lexicalSearch(scope)).map((row) => row.id).sort()).toEqual([...expected].sort());
    for (const entity of ['product', 'inventory']) {
      const exact = await lexicalSearch({
        ...scope,
        entity,
        freeText: 'SKU0',
        lexicalBranches: [],
        identifierTargets: [{ sourceId: source, entity, field: 'item_code' }],
      });
      expect(exact).toEqual([]);
      const structured = await hybridSearch({
        ...input(entity),
        filters: [{ field: 'item_code', op: 'eq', value: 'SKU0' }],
      });
      expect(structured.hits).toEqual([]);
    }
  });

  it('cannot be removed by implicit relaxation or preference candidate queries', async () => {
    const filter = { field: 'marca', op: 'eq' as const, value: 'missing' };
    const relaxed = buildRelaxedRetrievalState({
      safeFilters: [filter],
      implicitFilters: [filter],
      protectedFilters: [],
      appliedPreferences: [],
      fieldsByName: new Map(),
    });
    expect(relaxed?.filters).toEqual([]);
    const response = await hybridSearch({ ...input('product'), filters: relaxed!.filters });
    expect(response.hits.map((hit) => hit.id).sort()).toEqual([...expected].sort());
    const sets = buildPreferenceCandidateFilterSets(
      [],
      [{ field: 'marca', op: 'eq', value: 'wanted' }],
      input().filterableFields,
    );
    for (const filters of sets) {
      const candidates = await hybridSearch({ ...input('product'), filters });
      expect(candidates.hits.map((hit) => hit.id).sort()).toEqual([...expected].sort());
    }
    const condition = dialect.sqlToQuery(
      sql`SELECT count(*) FROM records r WHERE ${buildCatalogVisibilityCondition(tenant)}`,
    );
    const total = await client.query(condition.sql, condition.params);
    expect(Number(total.rows[0].count)).toBe(expected.length * 2 + names.length + 3);
    expect(Number((await client.query('SELECT count(*) FROM records')).rows[0].count)).toBe(
      names.length * 3 + 3,
    );
  });
});
