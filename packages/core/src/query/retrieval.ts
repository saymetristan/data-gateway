import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { NormalizedFilter, QueryType } from '../schemas/query.js';
import {
  buildLexicalBranches,
  type LexicalBranch,
} from './lexical-branches.js';
import {
  extractExplicitIdentifier,
  isShortSkuLikeQuery,
  normalizeIdentifier,
} from './text-utils.js';
import { reciprocalRankFusion } from './rrf.js';

const LEXICAL_CANDIDATE_LIMIT = 50;
const VECTOR_CANDIDATE_LIMIT = 50;
const VECTOR_PROBE_LIMIT = 200;
const HNSW_EF_SEARCH = 100;
const HNSW_MAX_SCAN_TUPLES = 1_000;
const TRIGRAM_THRESHOLD = 0.3;
/** Cap parallel distinctive/synonym branches to keep latency bounded. */
const MAX_LEXICAL_BRANCHES = 6;

/** Default RRF weights: slight lexical bias when vector is late/noisy. */
export const DEFAULT_LEXICAL_RRF_WEIGHT = 1;
export const DEFAULT_VECTOR_RRF_WEIGHT = 1.1;

export type RetrievalHit = {
  id: string;
  entity: string;
  sourceId: string;
  data: Record<string, unknown>;
  searchSource: string;
  score: number;
  lexicalMatch: boolean;
};

export type HybridSearchInput = {
  db: Database;
  workspaceId: string;
  sourceIds: string[];
  entity?: string;
  mappingVersionBySource: Map<string, number>;
  embeddingModel: string;
  filters: NormalizedFilter[];
  freeText: string;
  limit: number;
  filterableFields: Set<string>;
  embeddingProvider?: EmbeddingProvider;
  embeddingsAvailableBySource: Map<string, boolean>;
  /**
   * Precomputed query embedding.
   * - `undefined`: compute inside hybridSearch via embeddingProvider
   * - `null`: embed failed upstream; skip vector and use lexical only
   * - `number[]`: use this vector for ANN search
   */
  queryEmbedding?: number[] | null;
  lexicalWeight?: number;
  vectorWeight?: number;
  /** Optional precomputed lexical rows (parallel path). */
  precomputedLexicalRows?: RawRecordRow[];
  /** Optional synonym dictionary for multi-branch lexical expansion. */
  synonymDictionary?: Record<string, string[]>;
  /** Optional precomputed lexical branches (parallel path). */
  lexicalBranches?: LexicalBranch[];
  /** Mapping-derived identifier fields eligible for deterministic lookup. */
  identifierTargets?: IdentifierTarget[];
};

export type HybridSearchResult = {
  queryType: QueryType;
  hits: RetrievalHit[];
  lexicalRanking: string[];
  vectorRanking: string[];
  warnings: string[];
};

export type RawRecordRow = {
  id: string;
  entity: string;
  source_id: string;
  data: Record<string, unknown>;
  search_source: string;
  rank?: number;
  distance?: number;
  lexical_match?: boolean;
  identifier_match?: boolean;
};

export type IdentifierTarget = {
  sourceId: string;
  entity: string;
  field: string;
};

export type RetrievalScope = {
  db: Database;
  workspaceId: string;
  sourceIds: string[];
  entity?: string;
  filters: NormalizedFilter[];
  filterableFields: Set<string>;
  freeText: string;
  limit: number;
  synonymDictionary?: Record<string, string[]>;
  lexicalBranches?: LexicalBranch[];
  identifierTargets?: IdentifierTarget[];
};

export async function hybridSearch(input: HybridSearchInput): Promise<HybridSearchResult> {
  const warnings: string[] = [];
  const hasFreeText = input.freeText.trim().length > 0;

  if (!hasFreeText) {
    const hits = await filterOnlySearch(input);
    return {
      queryType: 'filter_only',
      hits: hits.map((row, index) => ({
        id: row.id,
        entity: row.entity,
        sourceId: row.source_id,
        data: row.data,
        searchSource: row.search_source,
        score: 1 - index * 0.001,
        lexicalMatch: false,
      })),
      lexicalRanking: [],
      vectorRanking: [],
      warnings,
    };
  }

  const lexicalRows =
    input.precomputedLexicalRows ?? (await lexicalSearch(toScope(input)));
  const lexicalRanking = lexicalRows.map((row) => row.id);

  let vectorRows: RawRecordRow[] = [];
  let vectorRanking: string[] = [];
  let anyEmbeddings = false;

  const sourcesWithEmbeddings = input.sourceIds.filter((sourceId) =>
    input.embeddingsAvailableBySource.get(sourceId),
  );
  anyEmbeddings = sourcesWithEmbeddings.length > 0;

  let queryEmbedding = input.queryEmbedding;
  if (anyEmbeddings && queryEmbedding === undefined) {
    try {
      queryEmbedding = await resolveQueryEmbedding(input);
    } catch {
      queryEmbedding = null;
      warnings.push('Query embedding failed; using lexical search only');
    }
  } else if (anyEmbeddings && queryEmbedding === null) {
    warnings.push('Query embedding failed; using lexical search only');
  }

  if (queryEmbedding) {
    vectorRows = await vectorSearchAcrossSources(input, sourcesWithEmbeddings, queryEmbedding, warnings);
  }

  vectorRows.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  vectorRanking = vectorRows.slice(0, VECTOR_CANDIDATE_LIMIT).map((row) => row.id);

  if (!anyEmbeddings || vectorRanking.length === 0) {
    if (!anyEmbeddings) {
      warnings.push('No embeddings available for source; using lexical search only');
    }
    return {
      queryType: 'lexical',
      hits: lexicalRowsToHits(lexicalRows, input.limit),
      lexicalRanking,
      vectorRanking,
      warnings,
    };
  }

  return {
    queryType: 'hybrid_search',
    hits: fuseHits(lexicalRows, vectorRows, lexicalRanking, vectorRanking, {
      limit: input.limit,
      ...(input.lexicalWeight !== undefined ? { lexicalWeight: input.lexicalWeight } : {}),
      ...(input.vectorWeight !== undefined ? { vectorWeight: input.vectorWeight } : {}),
    }),
    lexicalRanking,
    vectorRanking,
    warnings,
  };
}

export async function lexicalSearch(scope: RetrievalScope): Promise<RawRecordRow[]> {
  const queryText = scope.freeText.trim();
  if (!queryText) return [];
  const identifier = extractExplicitIdentifier(queryText);
  const identifierRows =
    identifier && (scope.identifierTargets?.length ?? 0) > 0
      ? await exactIdentifierSearch(scope, identifier)
      : [];

  const branches =
    scope.lexicalBranches ??
    buildLexicalBranches(queryText, scope.synonymDictionary ?? {});
  const limitedBranches = selectLexicalBranches(branches);

  // Single short query: keep the direct path (incl. SKU trigram).
  if (limitedBranches.length <= 1) {
    const lexicalRows = await lexicalSearchSingle(scope, queryText);
    return prependIdentifierRows(identifierRows, lexicalRows);
  }

  const lexicalRows = await lexicalSearchMultiBranch(scope, limitedBranches);
  return prependIdentifierRows(identifierRows, lexicalRows);
}

async function exactIdentifierSearch(
  scope: RetrievalScope,
  identifier: string,
): Promise<RawRecordRow[]> {
  const targets = scope.identifierTargets ?? [];
  if (targets.length === 0) return [];

  const normalized = normalizeIdentifier(identifier);
  if (!normalized) return [];

  const targetConditions = targets.map((target) => {
    const fieldKey = target.field.replace(/'/g, "''");
    const textPath = sql.raw(`r.data->>'${fieldKey}'`);
    return sql`(
      r.source_id = ${target.sourceId}
      AND r.entity = ${target.entity}
      AND (
        lower(public.f_unaccent(coalesce(${textPath}, ''))) =
          lower(public.f_unaccent(${identifier}))
        OR regexp_replace(
          lower(public.f_unaccent(coalesce(${textPath}, ''))),
          '[^a-z0-9]',
          '',
          'g'
        ) = ${normalized}
      )
    )`;
  });

  const where = buildWhereClause(scope);
  const result = await scope.db.execute(sql`
    SELECT
      r.id,
      r.entity,
      r.source_id,
      r.data,
      r.search_source,
      1::double precision AS rank,
      true AS lexical_match,
      true AS identifier_match
    FROM records r
    WHERE ${where}
      AND (${sql.join(targetConditions, sql` OR `)})
    ORDER BY r.updated_at DESC
    LIMIT ${LEXICAL_CANDIDATE_LIMIT}
  `);

  return rowsFromResult(result);
}

function prependIdentifierRows(
  identifierRows: RawRecordRow[],
  lexicalRows: RawRecordRow[],
): RawRecordRow[] {
  if (identifierRows.length === 0) return lexicalRows;
  const seen = new Set(identifierRows.map((row) => row.id));
  return [
    ...identifierRows,
    ...lexicalRows.filter((row) => !seen.has(row.id)),
  ].slice(0, LEXICAL_CANDIDATE_LIMIT);
}

/**
 * Run weighted multi-branch lexical retrieval and fuse with RRF so a
 * distinctive term like "Aida" can surface even when the full conversational
 * phrase has zero conjunctive FTS matches.
 */
export async function lexicalSearchMultiBranch(
  scope: RetrievalScope,
  branches: LexicalBranch[],
): Promise<RawRecordRow[]> {
  const rowById = new Map<string, RawRecordRow>();
  const rankings: Array<{ ids: string[]; weight: number }> = [];

  // Sequential to reuse one DB connection / RLS context; branch count is capped.
  for (const branch of branches) {
    const rows = await lexicalSearchSingle(scope, branch.text);
    const ids: string[] = [];
    for (const row of rows) {
      ids.push(row.id);
      const existing = rowById.get(row.id);
      if (!existing || (row.rank ?? 0) > (existing.rank ?? 0)) {
        rowById.set(row.id, {
          ...row,
          lexical_match: true,
        });
      } else {
        rowById.set(row.id, { ...existing, lexical_match: true });
      }
    }
    if (ids.length > 0) {
      rankings.push({ ids, weight: branch.weight });
    }
  }

  if (rankings.length === 0) return [];

  const fused = reciprocalRankFusion(rankings);
  return fused.slice(0, LEXICAL_CANDIDATE_LIMIT).map((item) => {
    const row = rowById.get(item.id);
    if (!row) {
      return {
        id: item.id,
        entity: '',
        source_id: '',
        data: {},
        search_source: '',
        rank: item.score,
        lexical_match: true,
      };
    }
    return {
      ...row,
      rank: item.score,
      lexical_match: true,
    };
  });
}

export async function lexicalSearchSingle(
  scope: RetrievalScope,
  queryText: string,
): Promise<RawRecordRow[]> {
  const where = buildWhereClause(scope);
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const useTrigram = isShortSkuLikeQuery(trimmed);

  const result = await scope.db.execute(sql`
    SELECT
      r.id,
      r.entity,
      r.source_id,
      r.data,
      r.search_source,
      ts_rank_cd(
        r.search_text,
        websearch_to_tsquery('es_unaccent', public.f_unaccent(${trimmed}))
      ) AS rank,
      (r.search_text @@ websearch_to_tsquery('es_unaccent', public.f_unaccent(${trimmed}))) AS lexical_match
    FROM records r
    WHERE ${where}
      AND (
        r.search_text @@ websearch_to_tsquery('es_unaccent', public.f_unaccent(${trimmed}))
        ${useTrigram ? sql`OR similarity(r.search_source, ${trimmed}) > ${TRIGRAM_THRESHOLD}` : sql``}
      )
    ORDER BY rank DESC, r.updated_at DESC
    LIMIT ${LEXICAL_CANDIDATE_LIMIT}
  `);

  return rowsFromResult(result);
}

export function selectLexicalBranches(branches: LexicalBranch[]): LexicalBranch[] {
  if (branches.length <= MAX_LEXICAL_BRANCHES) return branches;

  const full = branches.filter((branch) => branch.kind === 'full');
  const rest = branches
    .filter((branch) => branch.kind !== 'full')
    .sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  const budget = Math.max(0, MAX_LEXICAL_BRANCHES - full.length);
  return [...full, ...rest.slice(0, budget)];
}

export async function vectorSearchForSource(
  input: {
    db: Database;
    workspaceId: string;
    entity?: string;
    filters: NormalizedFilter[];
    filterableFields: Set<string>;
    embeddingModel: string;
    mappingVersion: number;
  },
  sourceId: string,
  vector: number[],
): Promise<RawRecordRow[]> {
  const vectorLiteral = `[${vector.join(',')}]`;
  const where = buildWhereClause({
    workspaceId: input.workspaceId,
    sourceIds: [sourceId],
    ...(input.entity ? { entity: input.entity } : {}),
    filters: input.filters,
    filterableFields: input.filterableFields,
  });

  const result = await input.db.execute(sql`
    WITH hnsw_settings AS MATERIALIZED (
      SELECT
        set_config('hnsw.ef_search', ${String(HNSW_EF_SEARCH)}, true) AS ef_search,
        set_config('hnsw.iterative_scan', 'strict_order', true) AS iterative_scan,
        set_config(
          'hnsw.max_scan_tuples',
          ${String(HNSW_MAX_SCAN_TUPLES)},
          true
        ) AS max_scan_tuples
    ),
    vector_candidates AS MATERIALIZED (
      SELECT candidate.record_id, candidate.distance
      FROM hnsw_settings settings
      CROSS JOIN LATERAL (
        SELECT
          re.record_id,
          (re.embedding <=> ${vectorLiteral}::vector) AS distance
        FROM record_embeddings re
        WHERE re.embedding_model = ${input.embeddingModel}
          AND re.mapping_version = ${input.mappingVersion}
          AND settings.iterative_scan IS NOT NULL
        ORDER BY re.embedding <=> ${vectorLiteral}::vector
        LIMIT ${VECTOR_PROBE_LIMIT}
      ) candidate
    )
    SELECT
      r.id,
      r.entity,
      r.source_id,
      r.data,
      r.search_source,
      vc.distance
    FROM vector_candidates vc
    INNER JOIN records r ON r.id = vc.record_id
    WHERE ${where}
    ORDER BY vc.distance ASC
    LIMIT ${VECTOR_CANDIDATE_LIMIT}
  `);

  return rowsFromResult(result);
}

export function fuseLexicalAndVector(input: {
  lexicalRows: RawRecordRow[];
  vectorRows: RawRecordRow[];
  limit: number;
  lexicalWeight?: number;
  vectorWeight?: number;
}): HybridSearchResult {
  const lexicalRanking = input.lexicalRows.map((row) => row.id);
  const vectorRanking = [...input.vectorRows]
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    .slice(0, VECTOR_CANDIDATE_LIMIT)
    .map((row) => row.id);

  if (vectorRanking.length === 0) {
    return {
      queryType: 'lexical',
      hits: lexicalRowsToHits(input.lexicalRows, input.limit),
      lexicalRanking,
      vectorRanking,
      warnings: [],
    };
  }

  return {
    queryType: 'hybrid_search',
    hits: fuseHits(
      input.lexicalRows,
      input.vectorRows,
      lexicalRanking,
      vectorRanking,
      {
        limit: input.limit,
        ...(input.lexicalWeight !== undefined ? { lexicalWeight: input.lexicalWeight } : {}),
        ...(input.vectorWeight !== undefined ? { vectorWeight: input.vectorWeight } : {}),
      },
    ),
    lexicalRanking,
    vectorRanking,
    warnings: [],
  };
}

export function lexicalRowsToHits(rows: RawRecordRow[], limit: number): RetrievalHit[] {
  return rows.slice(0, limit).map((row, index) => ({
    id: row.id,
    entity: row.entity,
    sourceId: row.source_id,
    data: row.data,
    searchSource: row.search_source,
    score: row.rank ?? 1 - index * 0.001,
    lexicalMatch: row.lexical_match ?? true,
  }));
}

async function vectorSearchAcrossSources(
  input: HybridSearchInput,
  sourceIds: string[],
  queryEmbedding: number[],
  warnings: string[],
): Promise<RawRecordRow[]> {
  let vectorRows: RawRecordRow[] = [];
  for (const sourceId of sourceIds) {
    const mappingVersion = input.mappingVersionBySource.get(sourceId);
    if (!mappingVersion) continue;
    try {
      const rows = await vectorSearchForSource(
        {
          db: input.db,
          workspaceId: input.workspaceId,
          ...(input.entity ? { entity: input.entity } : {}),
          filters: input.filters,
          filterableFields: input.filterableFields,
          embeddingModel: input.embeddingModel,
          mappingVersion,
        },
        sourceId,
        queryEmbedding,
      );
      vectorRows = vectorRows.concat(rows);
    } catch {
      warnings.push(`Vector search failed for source ${sourceId}; using lexical only`);
    }
  }
  return vectorRows;
}

function fuseHits(
  lexicalRows: RawRecordRow[],
  vectorRows: RawRecordRow[],
  lexicalRanking: string[],
  vectorRanking: string[],
  input: { limit: number; lexicalWeight?: number; vectorWeight?: number },
): RetrievalHit[] {
  const fused = reciprocalRankFusion([
    { ids: lexicalRanking, weight: input.lexicalWeight ?? DEFAULT_LEXICAL_RRF_WEIGHT },
    { ids: vectorRanking, weight: input.vectorWeight ?? DEFAULT_VECTOR_RRF_WEIGHT },
  ]);
  const rowById = new Map<string, RawRecordRow>();
  for (const row of [...lexicalRows, ...vectorRows]) {
    rowById.set(row.id, row);
  }

  const hits: RetrievalHit[] = [];
  const identifierIds = lexicalRows
    .filter((row) => row.identifier_match)
    .map((row) => row.id);
  const ordered = [
    ...identifierIds.map((id) => ({ id, score: 1 })),
    ...fused.filter((item) => !identifierIds.includes(item.id)),
  ];
  for (const item of ordered.slice(0, input.limit)) {
    const row = rowById.get(item.id);
    if (!row) continue;
    hits.push({
      id: row.id,
      entity: row.entity,
      sourceId: row.source_id,
      data: row.data,
      searchSource: row.search_source,
      score: item.score,
      lexicalMatch: row.lexical_match ?? lexicalRanking.includes(row.id),
    });
  }
  return hits;
}

async function filterOnlySearch(input: HybridSearchInput): Promise<RawRecordRow[]> {
  const where = buildWhereClause(toScope(input));
  const result = await input.db.execute(sql`
    SELECT r.id, r.entity, r.source_id, r.data, r.search_source
    FROM records r
    WHERE ${where}
    ORDER BY r.updated_at DESC
    LIMIT ${input.limit}
  `);

  return rowsFromResult(result);
}

async function resolveQueryEmbedding(input: HybridSearchInput): Promise<number[] | null> {
  if (!input.embeddingProvider) return null;
  const text = input.freeText.trim();
  if (!text) return null;
  const [vector] = await input.embeddingProvider.embed([text]);
  return vector ?? null;
}

function toScope(input: HybridSearchInput): RetrievalScope {
  return {
    db: input.db,
    workspaceId: input.workspaceId,
    sourceIds: input.sourceIds,
    ...(input.entity ? { entity: input.entity } : {}),
    filters: input.filters,
    filterableFields: input.filterableFields,
    freeText: input.freeText,
    limit: input.limit,
    ...(input.synonymDictionary ? { synonymDictionary: input.synonymDictionary } : {}),
    ...(input.lexicalBranches ? { lexicalBranches: input.lexicalBranches } : {}),
    ...(input.identifierTargets ? { identifierTargets: input.identifierTargets } : {}),
  };
}

function buildWhereClause(input: {
  workspaceId: string;
  sourceIds: string[];
  entity?: string;
  filters: NormalizedFilter[];
  filterableFields: Set<string>;
}): SQL {
  const parts: SQL[] = [sql`r.workspace_id = ${input.workspaceId}`];

  if (input.sourceIds.length === 1) {
    const sourceId = input.sourceIds[0];
    if (sourceId) {
      parts.push(sql`r.source_id = ${sourceId}`);
    }
  } else if (input.sourceIds.length > 1) {
    parts.push(sql`r.source_id IN (${sql.join(input.sourceIds.map((id) => sql`${id}`), sql`, `)})`);
  }

  if (input.entity) {
    parts.push(sql`r.entity = ${input.entity}`);
  }

  for (const filter of input.filters) {
    const condition = buildFilterCondition(filter, input.filterableFields);
    if (condition) parts.push(condition);
  }

  return sql.join(parts, sql` AND `);
}

function buildFilterCondition(
  filter: NormalizedFilter,
  allowedFields: Set<string>,
): SQL | null {
  if (!allowedFields.has(filter.field)) return null;

  const fieldKey = filter.field.replace(/'/g, "''");
  const textPath = sql.raw(`r.data->>'${fieldKey}'`);
  const jsonPath = sql.raw(`r.data->'${fieldKey}'`);

  switch (filter.op) {
    case 'eq': {
      const value = scalarToString(filter.value);
      // Scalar equality OR membership in JSON array / CSV legacy.
      return sql`(
        ${textPath} = ${value}
        OR (
          jsonb_typeof(${jsonPath}) = 'array'
          AND ${jsonPath} ? ${value}
        )
        OR (
          jsonb_typeof(${jsonPath}) IS DISTINCT FROM 'array'
          AND ${value} = ANY(
            string_to_array(regexp_replace(coalesce(${textPath}, ''), '\s*,\s*', ',', 'g'), ',')
          )
        )
      )`;
    }
    case 'neq':
      return sql`NOT (
        ${textPath} = ${scalarToString(filter.value)}
        OR (
          jsonb_typeof(${jsonPath}) = 'array'
          AND ${jsonPath} ? ${scalarToString(filter.value)}
        )
      )`;
    case 'gt':
      return sql`(${textPath})::numeric > ${Number(filter.value)}`;
    case 'gte':
      return sql`(${textPath})::numeric >= ${Number(filter.value)}`;
    case 'lt':
      return sql`(${textPath})::numeric < ${Number(filter.value)}`;
    case 'lte':
      return sql`(${textPath})::numeric <= ${Number(filter.value)}`;
    case 'in': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const asText = values.map((value) => scalarToString(value));
      return sql`(
        ${textPath} IN (${sql.join(asText.map((value) => sql`${value}`), sql`, `)})
        OR (
          jsonb_typeof(${jsonPath}) = 'array'
          AND ${jsonPath} ?| ARRAY[${sql.join(
            asText.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]
        )
      )`;
    }
    case 'contains': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const asText = values.map((value) => scalarToString(value));
      // All values must be present (array containment / CSV contains).
      return sql`(
        (
          jsonb_typeof(${jsonPath}) = 'array'
          AND ${jsonPath} ?& ARRAY[${sql.join(
            asText.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]
        )
        OR (
          jsonb_typeof(${jsonPath}) IS DISTINCT FROM 'array'
          AND ${sql.join(
            asText.map(
              (value) =>
                sql`${textPath} ILIKE ${'%' + value + '%'}`,
            ),
            sql` AND `,
          )}
        )
      )`;
    }
    case 'containsAny': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const asText = values.map((value) => scalarToString(value));
      return sql`(
        (
          jsonb_typeof(${jsonPath}) = 'array'
          AND ${jsonPath} ?| ARRAY[${sql.join(
            asText.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]
        )
        OR (
          jsonb_typeof(${jsonPath}) IS DISTINCT FROM 'array'
          AND ${sql.join(
            asText.map(
              (value) =>
                sql`${textPath} ILIKE ${'%' + value + '%'}`,
            ),
            sql` OR `,
          )}
        )
      )`;
    }
    case 'containsAll': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const asText = values.map((value) => scalarToString(value));
      return sql`(
        (
          jsonb_typeof(${jsonPath}) = 'array'
          AND ${jsonPath} ?& ARRAY[${sql.join(
            asText.map((value) => sql`${value}`),
            sql`, `,
          )}]::text[]
        )
        OR (
          jsonb_typeof(${jsonPath}) IS DISTINCT FROM 'array'
          AND ${sql.join(
            asText.map(
              (value) =>
                sql`${textPath} ILIKE ${'%' + value + '%'}`,
            ),
            sql` AND `,
          )}
        )
      )`;
    }
    default:
      return null;
  }
}

function scalarToString(value: NormalizedFilter['value']): string {
  if (Array.isArray(value)) {
    return String(value[0] ?? '');
  }
  return String(value);
}

function rowsFromResult(result: { rows?: unknown[] } | unknown[]): RawRecordRow[] {
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows as RawRecordRow[];
}
