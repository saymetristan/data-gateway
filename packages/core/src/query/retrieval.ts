import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { NormalizedFilter, QueryType } from '../schemas/query.js';
import { isShortSkuLikeQuery } from './text-utils.js';
import { reciprocalRankFusion } from './rrf.js';

const LEXICAL_CANDIDATE_LIMIT = 50;
const VECTOR_CANDIDATE_LIMIT = 50;
const TRIGRAM_THRESHOLD = 0.3;

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
};

export type HybridSearchResult = {
  queryType: QueryType;
  hits: RetrievalHit[];
  lexicalRanking: string[];
  vectorRanking: string[];
  warnings: string[];
};

type RawRecordRow = {
  id: string;
  entity: string;
  source_id: string;
  data: Record<string, unknown>;
  search_source: string;
  rank?: number;
  distance?: number;
  lexical_match?: boolean;
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

  const lexicalRows = await lexicalSearch(input);
  const lexicalRanking = lexicalRows.map((row) => row.id);

  let vectorRows: RawRecordRow[] = [];
  let vectorRanking: string[] = [];
  let anyEmbeddings = false;

  for (const sourceId of input.sourceIds) {
    if (!input.embeddingsAvailableBySource.get(sourceId)) continue;
    anyEmbeddings = true;
    try {
      const rows = await vectorSearch(input, sourceId);
      vectorRows = vectorRows.concat(rows);
    } catch {
      warnings.push(`Vector search failed for source ${sourceId}; using lexical only`);
    }
  }

  vectorRows.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  vectorRanking = vectorRows.slice(0, VECTOR_CANDIDATE_LIMIT).map((row) => row.id);

  if (!anyEmbeddings || vectorRanking.length === 0) {
    if (!anyEmbeddings) {
      warnings.push('No embeddings available for source; using lexical search only');
    }
    const hits = lexicalRows.slice(0, input.limit).map((row, index) => ({
      id: row.id,
      entity: row.entity,
      sourceId: row.source_id,
      data: row.data,
      searchSource: row.search_source,
      score: row.rank ?? 1 - index * 0.001,
      lexicalMatch: row.lexical_match ?? true,
    }));

    return {
      queryType: 'lexical',
      hits,
      lexicalRanking,
      vectorRanking,
      warnings,
    };
  }

  const fused = reciprocalRankFusion([lexicalRanking, vectorRanking]);
  const rowById = new Map<string, RawRecordRow>();
  for (const row of [...lexicalRows, ...vectorRows]) {
    rowById.set(row.id, row);
  }

  const hits: RetrievalHit[] = [];
  for (const item of fused.slice(0, input.limit)) {
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

  return {
    queryType: 'hybrid_search',
    hits,
    lexicalRanking,
    vectorRanking,
    warnings,
  };
}

async function filterOnlySearch(input: HybridSearchInput): Promise<RawRecordRow[]> {
  const where = buildWhereClause(input);
  const result = await input.db.execute(sql`
    SELECT r.id, r.entity, r.source_id, r.data, r.search_source
    FROM records r
    WHERE ${where}
    ORDER BY r.updated_at DESC
    LIMIT ${input.limit}
  `);

  return rowsFromResult(result);
}

async function lexicalSearch(input: HybridSearchInput): Promise<RawRecordRow[]> {
  const where = buildWhereClause(input);
  const queryText = input.freeText.trim();
  const useTrigram = isShortSkuLikeQuery(queryText);

  const result = await input.db.execute(sql`
    SELECT
      r.id,
      r.entity,
      r.source_id,
      r.data,
      r.search_source,
      ts_rank_cd(
        r.search_text,
        websearch_to_tsquery('es_unaccent', public.f_unaccent(${queryText}))
      ) AS rank,
      (r.search_text @@ websearch_to_tsquery('es_unaccent', public.f_unaccent(${queryText}))) AS lexical_match
    FROM records r
    WHERE ${where}
      AND (
        r.search_text @@ websearch_to_tsquery('es_unaccent', public.f_unaccent(${queryText}))
        ${useTrigram ? sql`OR similarity(r.search_source, ${queryText}) > ${TRIGRAM_THRESHOLD}` : sql``}
      )
    ORDER BY rank DESC, r.updated_at DESC
    LIMIT ${LEXICAL_CANDIDATE_LIMIT}
  `);

  return rowsFromResult(result);
}

async function vectorSearch(
  input: HybridSearchInput,
  sourceId: string,
): Promise<RawRecordRow[]> {
  if (!input.embeddingProvider) return [];

  const mappingVersion = input.mappingVersionBySource.get(sourceId);
  if (!mappingVersion) return [];

  const [vector] = await input.embeddingProvider.embed([input.freeText.trim()]);
  if (!vector) return [];

  const vectorLiteral = `[${vector.join(',')}]`;
  const where = buildWhereClause({ ...input, sourceIds: [sourceId] });

  const result = await input.db.execute(sql`
    SELECT
      r.id,
      r.entity,
      r.source_id,
      r.data,
      r.search_source,
      (re.embedding <=> ${vectorLiteral}::vector) AS distance
    FROM records r
    INNER JOIN record_embeddings re ON re.record_id = r.id
    WHERE ${where}
      AND re.embedding_model = ${input.embeddingModel}
      AND re.mapping_version = ${mappingVersion}
    ORDER BY distance ASC
    LIMIT ${VECTOR_CANDIDATE_LIMIT}
  `);

  return rowsFromResult(result);
}

function buildWhereClause(input: HybridSearchInput): SQL {
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
  const jsonPath = sql.raw(`r.data->>'${fieldKey}'`);

  switch (filter.op) {
    case 'eq':
      return sql`${jsonPath} = ${scalarToString(filter.value)}`;
    case 'neq':
      return sql`${jsonPath} <> ${scalarToString(filter.value)}`;
    case 'gt':
      return sql`(${jsonPath})::numeric > ${Number(filter.value)}`;
    case 'gte':
      return sql`(${jsonPath})::numeric >= ${Number(filter.value)}`;
    case 'lt':
      return sql`(${jsonPath})::numeric < ${Number(filter.value)}`;
    case 'lte':
      return sql`(${jsonPath})::numeric <= ${Number(filter.value)}`;
    case 'in': {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      return sql`${jsonPath} IN (${sql.join(values.map((value) => sql`${scalarToString(value)}`), sql`, `)})`;
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
