import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { queryLogs, recordEmbeddings, records, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { LlmProvider } from '../providers/llm.js';
import type { MappingDocument, MappingEntity } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import type {
  NormalizedFilter,
  QueryRequest,
  QueryResponse,
  QueryType,
} from '../schemas/query.js';
import { computeConfidence } from '../query/confidence.js';
import { extractFilters } from '../query/extract-filters.js';
import { extractFiltersWithLlm } from '../query/llm-fallback.js';
import { hybridSearch } from '../query/retrieval.js';
import {
  filterableFieldNames,
  shapeAppliedFilters,
  shapeRecordData,
} from '../query/shaping.js';
import { getActiveMapping } from './mappings.js';
import { getSourceProfile } from './profile.js';

const QUERYABLE_MATURITY = new Set(['indexed', 'validated', 'agent_ready']);

export type ExecuteQueryInput = {
  db: Database;
  workspaceId: string;
  apiKeyId?: string;
  request: QueryRequest;
  embeddingProvider: EmbeddingProvider;
  llmProvider?: LlmProvider;
};

type QueryableSource = {
  id: string;
  mappingVersion: number;
  document: MappingDocument;
  profile: SourceProfileDocument;
};

export async function executeQuery(input: ExecuteQueryInput): Promise<QueryResponse> {
  const started = Date.now();
  const warnings: string[] = [];
  let queryType: QueryType = 'filter_only';
  let appliedFilters: NormalizedFilter[] = [];
  let resultsCount = 0;
  let confidence = 0;
  let errorMessage: string | undefined;

  try {
    const queryable = await resolveQueryableSources(input.db, input.workspaceId, input.request.sourceId);
    if (queryable.length === 0) {
      throw GatewayError.conflict('No queryable sources found for workspace');
    }

    const entityFilter = input.request.entity;
    const sourceIds = queryable.map((source) => source.id);
    const mappingVersionBySource = new Map(
      queryable.map((source) => [source.id, source.mappingVersion]),
    );

    const extractedFilters: NormalizedFilter[] = [];
    let unresolvedText = input.request.query;

    for (const source of queryable) {
      const entities = pickEntities(source.document, entityFilter);
      for (const entity of entities) {
        const extracted = extractFilters({
          query: input.request.query,
          entity,
          profile: source.profile,
        });
        extractedFilters.push(...extracted.filters);
        unresolvedText = extracted.unresolvedText;
        warnings.push(...extracted.warnings);
      }
    }

    if (input.request.useLlmFallback && input.llmProvider && unresolvedText.trim()) {
      const primary = queryable[0];
      const entity = primary ? pickEntities(primary.document, entityFilter)[0] : undefined;
      if (primary && entity) {
        const llmResult = await extractFiltersWithLlm({
          unresolvedText,
          entity,
          profile: primary.profile,
          existingFilters: extractedFilters,
          llmProvider: input.llmProvider,
        });
        extractedFilters.push(...llmResult.filters);
        warnings.push(...llmResult.warnings);
      }
    }

    const mergedFilters = mergeFilters(
      extractedFilters,
      requestFiltersToNormalized(input.request.filters),
      collectDefaultFilters(queryable, entityFilter),
    );

    const filterableFields = collectFilterableFields(queryable, entityFilter);
    for (const filter of mergedFilters) {
      filterableFields.add(filter.field);
    }
    appliedFilters = shapeAppliedFilters(mergedFilters, collectAllFields(queryable, entityFilter));

    const embeddingsAvailableBySource = await resolveEmbeddingsAvailability(
      input.db,
      sourceIds,
      input.embeddingProvider.model,
      mappingVersionBySource,
    );

    const retrieval = await hybridSearch({
      db: input.db,
      workspaceId: input.workspaceId,
      sourceIds,
      ...(entityFilter ? { entity: entityFilter } : {}),
      mappingVersionBySource,
      embeddingModel: input.embeddingProvider.model,
      filters: mergedFilters,
      freeText: unresolvedText,
      limit: input.request.limit,
      filterableFields,
      embeddingProvider: input.embeddingProvider,
      embeddingsAvailableBySource,
    });

    queryType = retrieval.queryType;
    warnings.push(...retrieval.warnings);

    const fieldMap = buildFieldMap(queryable);
    const shapedResults = retrieval.hits.map((hit) => ({
      id: hit.id,
      entity: hit.entity,
      score: hit.score,
      data: shapeRecordData(hit.data, fieldMap.get(hit.entity) ?? []),
    }));

    confidence = computeConfidence({
      rankedScores: retrieval.hits.map((hit) => hit.score),
      requestedFilterCount: extractedFilters.length + Object.keys(input.request.filters ?? {}).length,
      appliedFilterCount: appliedFilters.length,
      topLexicalMatch: retrieval.hits[0]?.lexicalMatch ?? false,
      resultsCount: shapedResults.length,
      limit: input.request.limit,
    });

    resultsCount = shapedResults.length;

    const response: QueryResponse = {
      results: shapedResults,
      applied_filters: appliedFilters,
      query_type: queryType,
      confidence,
      sources_used: sourceIds,
      warnings,
    };

    await writeQueryLog(input, {
      rawQuery: input.request.query,
      structuredQuery: { extracted: extractedFilters, unresolvedText },
      queryType,
      appliedFilters,
      resultsCount,
      confidence,
      latencyMs: Date.now() - started,
      warnings,
    });

    return response;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown query error';
    await writeQueryLog(input, {
      rawQuery: input.request.query,
      structuredQuery: { extracted: appliedFilters },
      queryType,
      appliedFilters,
      resultsCount,
      confidence,
      latencyMs: Date.now() - started,
      warnings,
      error: errorMessage,
    });
    throw error;
  }
}

async function resolveQueryableSources(
  db: Database,
  workspaceId: string,
  sourceId?: string,
): Promise<QueryableSource[]> {
  const rows = await db
    .select()
    .from(sources)
    .where(
      sourceId
        ? and(eq(sources.workspaceId, workspaceId), eq(sources.id, sourceId))
        : eq(sources.workspaceId, workspaceId),
    );

  const queryable: QueryableSource[] = [];
  for (const source of rows) {
    if (!QUERYABLE_MATURITY.has(source.maturityStatus)) continue;

    try {
      const mapping = await getActiveMapping(db, source.id);
      const profile = await getSourceProfile(db, source.id);
      queryable.push({
        id: source.id,
        mappingVersion: mapping.version,
        document: mapping.document as MappingDocument,
        profile,
      });
    } catch {
      continue;
    }
  }

  return queryable;
}

async function resolveEmbeddingsAvailability(
  db: Database,
  sourceIds: string[],
  embeddingModel: string,
  mappingVersionBySource: Map<string, number>,
): Promise<Map<string, boolean>> {
  const availability = new Map<string, boolean>();
  if (sourceIds.length === 0) return availability;

  const rows = await db
    .select({
      sourceId: records.sourceId,
      mappingVersion: recordEmbeddings.mappingVersion,
      count: sql<number>`count(*)::int`,
    })
    .from(recordEmbeddings)
    .innerJoin(records, eq(records.id, recordEmbeddings.recordId))
    .where(
      and(
        inArray(records.sourceId, sourceIds),
        eq(recordEmbeddings.embeddingModel, embeddingModel),
      ),
    )
    .groupBy(records.sourceId, recordEmbeddings.mappingVersion);

  for (const sourceId of sourceIds) {
    const version = mappingVersionBySource.get(sourceId);
    const row = rows.find(
      (item) => item.sourceId === sourceId && item.mappingVersion === version,
    );
    availability.set(sourceId, Boolean(row && row.count > 0 && version !== undefined));
  }

  return availability;
}

function pickEntities(document: MappingDocument, entity?: string): MappingEntity[] {
  if (entity) {
    const match = document.entities.find((item) => item.entity === entity);
    return match ? [match] : [];
  }
  return document.entities;
}

function requestFiltersToNormalized(
  filters: QueryRequest['filters'],
): NormalizedFilter[] {
  if (!filters) return [];
  return Object.entries(filters).map(([field, value]) => ({
    field,
    op: Array.isArray(value) ? 'in' : 'eq',
    value,
  }));
}

function collectDefaultFilters(
  queryable: QueryableSource[],
  entity?: string,
): NormalizedFilter[] {
  const defaults: NormalizedFilter[] = [];
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      for (const filter of entityDef.defaultFilters) {
        defaults.push({
          field: filter.field,
          op: filter.op,
          value: filter.value,
        });
      }
    }
  }
  return defaults;
}

function collectFilterableFields(
  queryable: QueryableSource[],
  entity?: string,
): Set<string> {
  const names = new Set<string>();
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      for (const name of filterableFieldNames(entityDef.fields)) {
        names.add(name);
      }
    }
  }
  return names;
}

function collectAllFields(
  queryable: QueryableSource[],
  entity?: string,
) {
  const fields = [];
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      fields.push(...entityDef.fields);
    }
  }
  return fields;
}

function buildFieldMap(queryable: QueryableSource[]): Map<string, MappingEntity['fields']> {
  const map = new Map<string, MappingEntity['fields']>();
  for (const source of queryable) {
    for (const entityDef of source.document.entities) {
      map.set(entityDef.entity, entityDef.fields);
    }
  }
  return map;
}

/**
 * Default filters always win over request/extracted filters on the same field.
 */
function mergeFilters(
  extracted: NormalizedFilter[],
  requestFilters: NormalizedFilter[],
  defaults: NormalizedFilter[],
): NormalizedFilter[] {
  const byField = new Map<string, NormalizedFilter>();

  for (const filter of extracted) {
    byField.set(filter.field, filter);
  }
  for (const filter of requestFilters) {
    byField.set(filter.field, filter);
  }
  for (const filter of defaults) {
    byField.set(filter.field, filter);
  }

  return [...byField.values()];
}

type QueryLogPayload = {
  rawQuery: string;
  structuredQuery: Record<string, unknown>;
  queryType: QueryType;
  appliedFilters: NormalizedFilter[];
  resultsCount: number;
  confidence: number;
  latencyMs: number;
  warnings: string[];
  error?: string;
};

async function writeQueryLog(
  input: ExecuteQueryInput,
  payload: QueryLogPayload,
): Promise<void> {
  await input.db.insert(queryLogs).values({
    workspaceId: input.workspaceId,
    apiKeyId: input.apiKeyId ?? null,
    sourceId: input.request.sourceId ?? null,
    rawQuery: payload.rawQuery,
    structuredQuery: payload.structuredQuery,
    queryType: payload.queryType,
    appliedFilters: payload.appliedFilters,
    resultsCount: payload.resultsCount,
    confidence: payload.confidence,
    latencyMs: payload.latencyMs,
    warnings: payload.warnings,
    error: payload.error ?? null,
  });
}
