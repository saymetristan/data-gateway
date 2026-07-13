import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withWorkspaceContext } from '../db/rls.js';
import { queryLogs, recordEmbeddings, records, sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import type {
  EmbeddingAttemptMeta,
  EmbeddingProvider,
} from '../providers/embeddings.js';
import {
  DEFAULT_EMBEDDING_HARD_TIMEOUT_MS,
  DEFAULT_EMBEDDING_SOFT_DEADLINE_MS,
  OpenRouterEmbeddingProvider,
} from '../providers/embeddings.js';
import type { LlmProvider } from '../providers/llm.js';
import type { MappingDocument, MappingEntity, MappingField } from '../schemas/mapping.js';
import type { SourceProfileDocument } from '../schemas/profile.js';
import type {
  NormalizedFilter,
  QueryPreference,
  QueryRequest,
  QueryResponse,
  QueryType,
} from '../schemas/query.js';
import { normalizeRequestFilters } from '../schemas/query.js';
import { computeConfidence } from '../query/confidence.js';
import { extractFilters, resolveExtractedMatches } from '../query/extract-filters.js';
import { extractFiltersWithLlm } from '../query/llm-fallback.js';
import {
  fuseLexicalAndVector,
  hybridSearch,
  lexicalRowsToHits,
  lexicalSearch,
  vectorSearchForSource,
  type RawRecordRow,
} from '../query/retrieval.js';
import { applyPreferenceRescore, summarizeSignals } from '../query/rescore.js';
import { shapeAppliedFilters, shapeRecordData } from '../query/shaping.js';
import { expandQueryWithSynonyms } from '../query/synonyms.js';
import { getFieldRetrieval } from '../schemas/mapping.js';
import { getFilterableTargets } from '../mapping/metadata.js';
import {
  buildQueryEmbeddingCacheHash,
  getSharedQueryEmbeddingCache,
  type CacheLayer,
} from './query-embedding-cache.js';
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
  requiredMaturity?: 'agent_ready';
  allowedSourceIds?: string[];
  presetFilters?: NormalizedFilter[];
  softDeadlineMs?: number;
  hardTimeoutMs?: number;
  enableSynonymExpansion?: boolean;
  logContext?: {
    toolName?: string;
    mappingVersion?: number;
  };
};

export type QueryTimingMetadata = {
  prepareMs: number;
  lexicalMs: number;
  cacheMs: number;
  providerMs: number;
  vectorMs: number;
  fusionMs: number;
  totalMs: number;
};

export type QueryResilienceMetadata = {
  timings: QueryTimingMetadata;
  cache: CacheLayer;
  circuitState?: string;
  providerAttempts?: number;
  fallbackReason?: string;
  synonymDictVersion?: string | undefined;
  synonymTermsAdded?: string[] | undefined;
  rankingSignals?: Array<{ id: string; matched: string[] }> | undefined;
  softDeadlineMs: number;
  hardTimeoutMs: number;
};

type QueryableSource = {
  id: string;
  mappingVersion: number;
  document: MappingDocument;
  profile: SourceProfileDocument;
};

type PreparedQuery = {
  queryable: QueryableSource[];
  sourceIds: string[];
  mappingVersionBySource: Map<string, number>;
  extractedFilters: NormalizedFilter[];
  extractedPreferences: QueryPreference[];
  unresolvedText: string;
  safeFilters: NormalizedFilter[];
  appliedFilters: NormalizedFilter[];
  appliedPreferences: QueryPreference[];
  filterableFields: Set<string>;
  preferableFields: Set<string>;
  fieldsByName: Map<string, MappingField>;
  synonymDictionary: Record<string, string[]>;
  synonymDictVersion?: string;
  lexicalWeight: number;
  vectorWeight: number;
  embeddingsAvailableBySource: Map<string, boolean>;
  warnings: string[];
};

type EmbeddingResolution = {
  embedding: number[] | null;
  cache: CacheLayer;
  providerMs: number;
  cacheMs: number;
  providerMeta?: EmbeddingAttemptMeta;
  fallbackReason?: string;
  lateWrite?: Promise<void>;
};

export async function executeQuery(input: ExecuteQueryInput): Promise<QueryResponse> {
  const started = Date.now();
  const softDeadlineMs =
    input.softDeadlineMs ??
    (input.embeddingProvider instanceof OpenRouterEmbeddingProvider
      ? input.embeddingProvider.softDeadline
      : DEFAULT_EMBEDDING_SOFT_DEADLINE_MS);
  const hardTimeoutMs =
    input.hardTimeoutMs ??
    (input.embeddingProvider instanceof OpenRouterEmbeddingProvider
      ? input.embeddingProvider.hardTimeout
      : DEFAULT_EMBEDDING_HARD_TIMEOUT_MS);

  const warnings: string[] = [];
  let queryType: QueryType = 'filter_only';
  let appliedFilters: NormalizedFilter[] = [];
  let appliedPreferences: QueryPreference[] = [];
  let resultsCount = 0;
  let confidence = 0;
  let errorMessage: string | undefined;
  const metadata: QueryResilienceMetadata = {
    timings: {
      prepareMs: 0,
      lexicalMs: 0,
      cacheMs: 0,
      providerMs: 0,
      vectorMs: 0,
      fusionMs: 0,
      totalMs: 0,
    },
    cache: 'miss',
    softDeadlineMs,
    hardTimeoutMs,
  };

  try {
    const prepareStarted = Date.now();
    const prepared = await withWorkspaceContext(input.db, input.workspaceId, (tx) =>
      prepareQuery(tx, input),
    );
    metadata.timings.prepareMs = Date.now() - prepareStarted;
    warnings.push(...prepared.warnings);
    appliedFilters = prepared.appliedFilters;
    appliedPreferences = prepared.appliedPreferences;

    const unresolvedText = prepared.unresolvedText;
    const extractedFilters = [...prepared.extractedFilters];
    const extractedPreferences = [...prepared.extractedPreferences];

    if (input.request.useLlmFallback && input.llmProvider && unresolvedText.trim()) {
      const primary = prepared.queryable[0];
      const entity = primary
        ? pickEntities(primary.document, input.request.entity)[0]
        : undefined;
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

        const defaultFilters = collectDefaultFilters(prepared.queryable, input.request.entity);
        const mergedFilters = mergeFilters(
          [...extractedFilters, ...(input.presetFilters ?? [])],
          normalizeRequestFilters(input.request.filters),
          defaultFilters,
        );
        const filterableFields = new Set(prepared.filterableFields);
        for (const filter of defaultFilters) filterableFields.add(filter.field);
        for (const filter of input.presetFilters ?? []) filterableFields.add(filter.field);

        const safeFilters = mergedFilters.filter((filter) => {
          if (filterableFields.has(filter.field)) return true;
          warnings.push(`Filter on non-filterable field "${filter.field}" ignored`);
          return false;
        });
        prepared.safeFilters = safeFilters;
        prepared.filterableFields = filterableFields;
        prepared.appliedFilters = shapeAppliedFilters(
          safeFilters,
          collectAllFields(prepared.queryable, input.request.entity),
        );
        appliedFilters = prepared.appliedFilters;
      }
    }

    const enableSynonyms = input.enableSynonymExpansion !== false;
    let searchText = unresolvedText.trim();
    if (enableSynonyms && searchText && Object.keys(prepared.synonymDictionary).length > 0) {
      const expanded = expandQueryWithSynonyms(searchText, prepared.synonymDictionary);
      if (expanded.addedTerms.length > 0) {
        searchText = expanded.expanded;
        metadata.synonymDictVersion = prepared.synonymDictVersion;
        metadata.synonymTermsAdded = expanded.addedTerms;
      }
    }

    const hasFreeText = unresolvedText.trim().length > 0;
    const needsEmbedding =
      hasFreeText &&
      prepared.sourceIds.some((sourceId) => prepared.embeddingsAvailableBySource.get(sourceId));

    if (!hasFreeText) {
      const response = await withWorkspaceContext(input.db, input.workspaceId, async (tx) => {
        const fusionStarted = Date.now();
        const retrieval = await hybridSearch({
          db: tx,
          workspaceId: input.workspaceId,
          sourceIds: prepared.sourceIds,
          ...(input.request.entity ? { entity: input.request.entity } : {}),
          mappingVersionBySource: prepared.mappingVersionBySource,
          embeddingModel: input.embeddingProvider.model,
          filters: prepared.safeFilters,
          freeText: '',
          limit:
            prepared.appliedPreferences.length > 0
              ? Math.max(input.request.limit * 3, 30)
              : input.request.limit,
          filterableFields: prepared.filterableFields,
          embeddingsAvailableBySource: prepared.embeddingsAvailableBySource,
          lexicalWeight: prepared.lexicalWeight,
          vectorWeight: prepared.vectorWeight,
        });
        metadata.timings.fusionMs = Date.now() - fusionStarted;
        return finalizeResponse({
          input: { ...input, db: tx },
          prepared,
          retrievalHits: retrieval.hits,
          queryType: retrieval.queryType,
          warnings: [...warnings, ...retrieval.warnings],
          extractedFilters,
          extractedPreferences,
          unresolvedText,
          appliedFilters,
          appliedPreferences,
          started,
          metadata,
        });
      });
      return response;
    }

    // Parallel: lexical (DB) + embedding resolution (cache/provider, no DB hold on provider wait).
    const parallelStarted = Date.now();
    const lexicalPromise = withWorkspaceContext(input.db, input.workspaceId, (tx) =>
      lexicalSearch({
        db: tx,
        workspaceId: input.workspaceId,
        sourceIds: prepared.sourceIds,
        ...(input.request.entity ? { entity: input.request.entity } : {}),
        filters: prepared.safeFilters,
        filterableFields: prepared.filterableFields,
        freeText: searchText,
        limit: input.request.limit,
      }),
    ).then((rows) => {
      metadata.timings.lexicalMs = Date.now() - parallelStarted;
      return rows;
    });

    const embeddingPromise = needsEmbedding
      ? resolveQueryEmbedding(input, unresolvedText.trim(), softDeadlineMs, hardTimeoutMs)
      : Promise.resolve<EmbeddingResolution>({
          embedding: null,
          cache: 'miss',
          providerMs: 0,
          cacheMs: 0,
        });

    const [lexicalRows, embeddingResolution] = await Promise.all([
      lexicalPromise,
      embeddingPromise,
    ]);

    metadata.cache = embeddingResolution.cache;
    metadata.timings.cacheMs = embeddingResolution.cacheMs;
    metadata.timings.providerMs = embeddingResolution.providerMs;
    if (embeddingResolution.providerMeta) {
      metadata.circuitState = embeddingResolution.providerMeta.circuitState;
      metadata.providerAttempts = embeddingResolution.providerMeta.attempts;
    }
    if (embeddingResolution.fallbackReason) {
      metadata.fallbackReason = embeddingResolution.fallbackReason;
      warnings.push(
        embeddingResolution.fallbackReason === 'circuit_open'
          ? 'Embedding circuit open; using lexical search only'
          : embeddingResolution.fallbackReason === 'deadline'
            ? 'Query embedding missed soft deadline; using lexical search only'
            : 'Query embedding failed; using lexical search only',
      );
    }

    // Fire-and-forget late cache write if provider eventually succeeds.
    if (embeddingResolution.lateWrite) {
      void embeddingResolution.lateWrite.catch(() => undefined);
    }

    const response = await withWorkspaceContext(input.db, input.workspaceId, async (tx) => {
      let vectorRows: RawRecordRow[] = [];
      const vectorStarted = Date.now();

      if (embeddingResolution.embedding) {
        const sourcesWithEmbeddings = prepared.sourceIds.filter((sourceId) =>
          prepared.embeddingsAvailableBySource.get(sourceId),
        );
        for (const sourceId of sourcesWithEmbeddings) {
          const mappingVersion = prepared.mappingVersionBySource.get(sourceId);
          if (!mappingVersion) continue;
          try {
            const rows = await vectorSearchForSource(
              {
                db: tx,
                workspaceId: input.workspaceId,
                ...(input.request.entity ? { entity: input.request.entity } : {}),
                filters: prepared.safeFilters,
                filterableFields: prepared.filterableFields,
                embeddingModel: input.embeddingProvider.model,
                mappingVersion,
              },
              sourceId,
              embeddingResolution.embedding,
            );
            vectorRows = vectorRows.concat(rows);
          } catch {
            warnings.push(`Vector search failed for source ${sourceId}; using lexical only`);
          }
        }
      }
      metadata.timings.vectorMs = Date.now() - vectorStarted;

      const fusionStarted = Date.now();
      const retrieval =
        vectorRows.length > 0
          ? fuseLexicalAndVector({
              lexicalRows,
              vectorRows,
              limit: Math.max(input.request.limit * 3, 30),
              lexicalWeight: prepared.lexicalWeight,
              vectorWeight: prepared.vectorWeight,
            })
          : {
              queryType: 'lexical' as const,
              hits: lexicalRowsToHits(
                lexicalRows,
                Math.max(input.request.limit * 3, 30),
              ),
              lexicalRanking: lexicalRows.map((row) => row.id),
              vectorRanking: [] as string[],
              warnings: [] as string[],
            };
      metadata.timings.fusionMs = Date.now() - fusionStarted;
      warnings.push(...retrieval.warnings);

      return finalizeResponse({
        input: { ...input, db: tx },
        prepared,
        retrievalHits: retrieval.hits,
        queryType: retrieval.queryType,
        warnings,
        extractedFilters,
        extractedPreferences,
        unresolvedText,
        appliedFilters,
        appliedPreferences,
        started,
        metadata,
      });
    });

    queryType = response.query_type;
    resultsCount = response.results.length;
    confidence = response.confidence;
    return response;
  } catch (error) {
    errorMessage =
      error instanceof GatewayError ? error.message : 'Query execution failed';
    metadata.timings.totalMs = Date.now() - started;
    await withWorkspaceContext(input.db, input.workspaceId, (tx) =>
      writeQueryLog(
        { ...input, db: tx },
        {
          rawQuery: input.request.query,
          structuredQuery: { extracted: appliedFilters },
          queryType,
          appliedFilters,
          resultsCount,
          confidence,
          latencyMs: metadata.timings.totalMs,
          warnings,
          metadata,
          ...(errorMessage ? { error: errorMessage } : {}),
        },
      ),
    ).catch(() => undefined);
    throw error;
  }
}

async function resolveQueryEmbedding(
  input: ExecuteQueryInput,
  queryText: string,
  softDeadlineMs: number,
  hardTimeoutMs: number,
): Promise<EmbeddingResolution> {
  const cache = getSharedQueryEmbeddingCache();
  const cacheStarted = Date.now();

  const cached = await withWorkspaceContext(input.db, input.workspaceId, (tx) =>
    cache.lookup(tx, {
      workspaceId: input.workspaceId,
      query: queryText,
      model: input.embeddingProvider.model,
      dimensions: input.embeddingProvider.dimensions,
    }),
  ).catch(() => null);

  const cacheMs = Date.now() - cacheStarted;
  if (cached) {
    return {
      embedding: cached.embedding,
      cache: cached.layer,
      providerMs: 0,
      cacheMs,
    };
  }

  const queryHash = buildQueryEmbeddingCacheHash({
    model: input.embeddingProvider.model,
    dimensions: input.embeddingProvider.dimensions,
    query: queryText,
  });
  const inflightKey = `${input.workspaceId}:${queryHash}`;

  const providerStarted = Date.now();

  const providerPromise = cache.resolveOrLoad(inflightKey, async () => {
    if (input.embeddingProvider.embedWithMeta) {
      const result = await input.embeddingProvider.embedWithMeta([queryText]);
      const vector = result.vectors[0];
      if (!vector) throw new Error('Empty embedding');
      return vector;
    }
    const [vector] = await input.embeddingProvider.embed([queryText]);
    if (!vector) throw new Error('Empty embedding');
    return vector;
  });

  const softRace = Promise.race([
    providerPromise.then((embedding) => ({ kind: 'ok' as const, embedding })),
    sleep(softDeadlineMs).then(() => ({ kind: 'deadline' as const })),
  ]);

  const raced = await softRace;
  const providerMs = Date.now() - providerStarted;

  if (raced.kind === 'ok') {
    const embedding = raced.embedding;
    const lateWrite = withWorkspaceContext(input.db, input.workspaceId, (tx) =>
      cache.store(tx, {
        workspaceId: input.workspaceId,
        query: queryText,
        model: input.embeddingProvider.model,
        dimensions: input.embeddingProvider.dimensions,
        embedding,
      }),
    ).then(() => undefined);
    return {
      embedding,
      cache: 'miss',
      providerMs,
      cacheMs,
      lateWrite,
    };
  }

  // Soft deadline missed — continue provider until hard timeout for cache warm.
  const lateWrite = Promise.race([
    providerPromise,
    sleep(Math.max(0, hardTimeoutMs - providerMs)).then(() => null),
  ]).then(async (embedding) => {
    if (!embedding) return;
    await withWorkspaceContext(input.db, input.workspaceId, (tx) =>
      cache.store(tx, {
        workspaceId: input.workspaceId,
        query: queryText,
        model: input.embeddingProvider.model,
        dimensions: input.embeddingProvider.dimensions,
        embedding,
      }),
    ).catch(() => undefined);
  });

  let fallbackReason = 'deadline';
  let providerMeta: EmbeddingAttemptMeta | undefined;

  // If provider already failed before/at deadline, prefer that reason.
  const settled = await Promise.race([
    providerPromise.then(
      (embedding) => ({ status: 'fulfilled' as const, embedding }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    ),
    Promise.resolve(null),
  ]);
  if (settled?.status === 'rejected') {
    fallbackReason = extractFallbackReason(settled.error);
    providerMeta = extractProviderMeta(settled.error);
  }

  return {
    embedding: null,
    cache: 'miss',
    providerMs,
    cacheMs,
    ...(providerMeta ? { providerMeta } : {}),
    fallbackReason,
    lateWrite,
  };
}

function extractFallbackReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const raw = (error as { code?: unknown }).code;
    const code = typeof raw === 'string' ? raw : '';
    if (code === 'CIRCUIT_OPEN') return 'circuit_open';
    if (code === 'TIMEOUT') return 'timeout';
  }
  return 'provider_error';
}

function extractProviderMeta(error: unknown): EmbeddingAttemptMeta | undefined {
  if (error && typeof error === 'object' && 'meta' in error) {
    return (error as { meta?: EmbeddingAttemptMeta }).meta;
  }
  return undefined;
}

async function finalizeResponse(args: {
  input: ExecuteQueryInput;
  prepared: PreparedQuery;
  retrievalHits: Array<{
    id: string;
    entity: string;
    score: number;
    data: Record<string, unknown>;
    lexicalMatch: boolean;
  }>;
  queryType: QueryType;
  warnings: string[];
  extractedFilters: NormalizedFilter[];
  extractedPreferences: QueryPreference[];
  unresolvedText: string;
  appliedFilters: NormalizedFilter[];
  appliedPreferences: QueryPreference[];
  started: number;
  metadata: QueryResilienceMetadata;
}): Promise<QueryResponse> {
  const {
    input,
    prepared,
    retrievalHits,
    queryType,
    warnings,
    extractedFilters,
    extractedPreferences,
    unresolvedText,
    appliedFilters,
    appliedPreferences,
    started,
    metadata,
  } = args;

  const rescored = applyPreferenceRescore(
    retrievalHits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      data: hit.data,
    })),
    appliedPreferences,
    prepared.fieldsByName,
  );

  const hitById = new Map(retrievalHits.map((hit) => [hit.id, hit]));
  const rankedHits = rescored.hits
    .slice(0, input.request.limit)
    .map((item) => {
      const original = hitById.get(item.id);
      return {
        id: item.id,
        entity: original?.entity ?? '',
        score: item.score,
        data: item.data,
        lexicalMatch: original?.lexicalMatch ?? false,
      };
    });

  metadata.rankingSignals = summarizeSignals(
    rescored.signalsById,
    rankedHits.slice(0, 5).map((hit) => hit.id),
  );

  const fieldMap = buildFieldMap(prepared.queryable);
  const shapedResults = rankedHits.map((hit) => ({
    id: hit.id,
    entity: hit.entity,
    score: hit.score,
    data: shapeRecordData(hit.data, fieldMap.get(hit.entity) ?? []),
  }));

  const confidence = computeConfidence({
    rankedScores: rankedHits.map((hit) => hit.score),
    requestedFilterCount:
      extractedFilters.length + normalizeRequestFilters(input.request.filters).length,
    appliedFilterCount: appliedFilters.length,
    topLexicalMatch: rankedHits[0]?.lexicalMatch ?? false,
    resultsCount: shapedResults.length,
    limit: input.request.limit,
  });

  metadata.timings.totalMs = Date.now() - started;

  const payload: QueryResponse = {
    results: shapedResults,
    applied_filters: appliedFilters,
    ...(appliedPreferences.length > 0 ? { applied_preferences: appliedPreferences } : {}),
    query_type: queryType,
    confidence,
    sources_used: prepared.sourceIds,
    warnings,
  };

  await writeQueryLog(input, {
    rawQuery: input.request.query,
    structuredQuery: {
      extracted: extractedFilters,
      preferences: extractedPreferences,
      unresolvedText,
      ...(input.logContext?.toolName ? { toolName: input.logContext.toolName } : {}),
      ...(input.logContext?.mappingVersion !== undefined
        ? { mappingVersion: input.logContext.mappingVersion }
        : {}),
    },
    queryType,
    appliedFilters,
    resultsCount: shapedResults.length,
    confidence,
    latencyMs: metadata.timings.totalMs,
    warnings,
    metadata,
  });

  return payload;
}

async function prepareQuery(db: Database, input: ExecuteQueryInput): Promise<PreparedQuery> {
  const warnings: string[] = [];
  const queryable = await resolveQueryableSources(
    db,
    input.workspaceId,
    input.request.sourceId,
    input.requiredMaturity,
    input.allowedSourceIds,
  );
  if (queryable.length === 0) {
    throw GatewayError.conflict('No queryable sources found for workspace');
  }

  const entityFilter = input.request.entity;
  const sourceIds = queryable.map((source) => source.id);
  const mappingVersionBySource = new Map(
    queryable.map((source) => [source.id, source.mappingVersion]),
  );

  const allFields = collectAllFields(queryable, entityFilter);
  const fieldsByName = new Map(allFields.map((field) => [field.name, field]));

  const extractedMatches = [];
  const extractWarnings: string[] = [];
  for (const source of queryable) {
    const entities = pickEntities(source.document, entityFilter);
    for (const entity of entities) {
      const extracted = extractFilters({
        query: input.request.query,
        entity,
        profile: source.profile,
      });
      extractedMatches.push(...extracted.matches);
      extractWarnings.push(...extracted.warnings);
    }
  }

  const resolved = resolveExtractedMatches({
    query: input.request.query,
    matches: extractedMatches,
    fieldsByName,
    extraWarnings: extractWarnings,
  });
  warnings.push(...resolved.warnings);

  const extractedFilters = resolved.filters;
  const unresolvedText = resolved.unresolvedText;

  const defaultFilters = collectDefaultFilters(queryable, entityFilter);
  const mergedFilters = mergeFilters(
    [...extractedFilters, ...(input.presetFilters ?? [])],
    normalizeRequestFilters(input.request.filters),
    defaultFilters,
  );

  const filterableFields = collectFilterableFields(queryable, entityFilter);
  for (const filter of defaultFilters) {
    filterableFields.add(filter.field);
  }
  for (const filter of input.presetFilters ?? []) {
    filterableFields.add(filter.field);
  }
  const safeFilters = mergedFilters.filter((filter) => {
    if (isSensitiveField(fieldsByName.get(filter.field))) {
      warnings.push(`Filter on sensitive field "${filter.field}" ignored`);
      return false;
    }
    if (filterableFields.has(filter.field)) return true;
    warnings.push(`Filter on non-filterable field "${filter.field}" ignored`);
    return false;
  });
  const appliedFilters = shapeAppliedFilters(safeFilters, allFields);

  const preferableFields = collectPreferableFields(queryable, entityFilter);
  const mappingSoftPreferences = collectSoftPreferences(queryable, entityFilter);
  const requestPreferences = [
    ...resolved.preferences,
    ...(input.request.preferences ?? []),
    ...mappingSoftPreferences,
  ];
  const appliedPreferences = sanitizePreferences(
    requestPreferences,
    preferableFields,
    fieldsByName,
    warnings,
  );

  const synonymConfig = collectSynonymDictionary(queryable, entityFilter);
  const rrf = collectRrfWeights(queryable, entityFilter);

  const embeddingsAvailableBySource = await resolveEmbeddingsAvailability(
    db,
    sourceIds,
    input.embeddingProvider.model,
    mappingVersionBySource,
  );

  return {
    queryable,
    sourceIds,
    mappingVersionBySource,
    extractedFilters,
    extractedPreferences: resolved.preferences,
    unresolvedText,
    safeFilters,
    appliedFilters,
    appliedPreferences,
    filterableFields,
    preferableFields,
    fieldsByName,
    synonymDictionary: synonymConfig.entries,
    ...(synonymConfig.version ? { synonymDictVersion: synonymConfig.version } : {}),
    lexicalWeight: rrf.lexicalWeight,
    vectorWeight: rrf.vectorWeight,
    embeddingsAvailableBySource,
    warnings,
  };
}

async function resolveQueryableSources(
  db: Database,
  workspaceId: string,
  sourceId?: string,
  requiredMaturity?: 'agent_ready',
  allowedSourceIds?: string[],
): Promise<QueryableSource[]> {
  const rows = await db
    .select()
    .from(sources)
    .where(
      sourceId
        ? and(eq(sources.workspaceId, workspaceId), eq(sources.id, sourceId))
        : eq(sources.workspaceId, workspaceId),
    );

  const allowed = allowedSourceIds ? new Set(allowedSourceIds) : null;
  const queryable: QueryableSource[] = [];
  for (const source of rows) {
    if (allowed && !allowed.has(source.id)) continue;
    if (requiredMaturity) {
      if (source.maturityStatus !== requiredMaturity) continue;
    } else if (!QUERYABLE_MATURITY.has(source.maturityStatus)) {
      continue;
    }

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

function collectDefaultFilters(
  queryable: QueryableSource[],
  entity?: string,
): NormalizedFilter[] {
  const defaults: NormalizedFilter[] = [];
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      for (const filter of entityDef.defaultFilters ?? []) {
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

function collectSoftPreferences(
  queryable: QueryableSource[],
  entity?: string,
): QueryPreference[] {
  const preferences: QueryPreference[] = [];
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      for (const preference of entityDef.retrieval?.softPreferences ?? []) {
        preferences.push({
          field: preference.field,
          op: preference.op,
          value: preference.value,
          boost: preference.boost,
        });
      }
    }
  }
  return preferences;
}

function collectSynonymDictionary(
  queryable: QueryableSource[],
  entity?: string,
): { version?: string; entries: Record<string, string[]> } {
  const entries: Record<string, string[]> = {};
  let version: string | undefined;
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      const synonyms = entityDef.retrieval?.synonyms;
      if (!synonyms) continue;
      version = synonyms.version;
      for (const [term, list] of Object.entries(synonyms.entries)) {
        const existing = entries[term] ?? [];
        entries[term] = [...new Set([...existing, ...list])];
      }
    }
  }
  return version ? { version, entries } : { entries };
}

function collectRrfWeights(
  queryable: QueryableSource[],
  entity?: string,
): { lexicalWeight: number; vectorWeight: number } {
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      const rrf = entityDef.retrieval?.rrf;
      if (rrf) {
        return {
          lexicalWeight: rrf.lexicalWeight,
          vectorWeight: rrf.vectorWeight,
        };
      }
    }
  }
  return { lexicalWeight: 1, vectorWeight: 1.1 };
}

function collectFilterableFields(
  queryable: QueryableSource[],
  entity?: string,
): Set<string> {
  const names = new Set<string>();
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      for (const target of getFilterableTargets(entityDef)) {
        names.add(target.name);
      }
    }
  }
  return names;
}

function collectPreferableFields(
  queryable: QueryableSource[],
  entity?: string,
): Set<string> {
  const names = new Set<string>();
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      for (const field of entityDef.fields) {
        if (field.sensitive) continue;
        if (field.filterable || getFieldRetrieval(field).inferredBehavior === 'prefer') {
          names.add(field.name);
        }
      }
    }
  }
  return names;
}

function sanitizePreferences(
  preferences: QueryPreference[],
  preferableFields: Set<string>,
  fieldsByName: Map<string, MappingField>,
  warnings: string[],
): QueryPreference[] {
  const sanitized: QueryPreference[] = [];
  const seen = new Set<string>();
  for (const preference of preferences) {
    const key = `${preference.field}:${preference.op}:${JSON.stringify(preference.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const field = fieldsByName.get(preference.field);
    if (isSensitiveField(field)) {
      warnings.push(`Preference on sensitive field "${preference.field}" ignored`);
      continue;
    }
    if (!preferableFields.has(preference.field)) {
      warnings.push(`Preference on non-preferable field "${preference.field}" ignored`);
      continue;
    }
    const retrieval = field ? getFieldRetrieval(field) : undefined;
    sanitized.push({
      field: preference.field,
      op: preference.op,
      value: preference.value,
      boost: preference.boost ?? retrieval?.boost ?? 0.15,
    });
  }
  return sanitized;
}

function isSensitiveField(field?: MappingField): boolean {
  return Boolean(field?.sensitive);
}

function collectAllFields(
  queryable: QueryableSource[],
  entity?: string,
) {
  const fields: MappingField[] = [];
  for (const source of queryable) {
    for (const entityDef of pickEntities(source.document, entity)) {
      fields.push(...entityDef.fields);
      fields.push(...relationAggregateFields(entityDef));
    }
  }
  return fields;
}

function buildFieldMap(queryable: QueryableSource[]): Map<string, MappingField[]> {
  const map = new Map<string, MappingField[]>();
  for (const source of queryable) {
    for (const entityDef of source.document.entities) {
      map.set(entityDef.entity, [...entityDef.fields, ...relationAggregateFields(entityDef)]);
    }
  }
  return map;
}

function relationAggregateFields(entity: MappingEntity): MappingField[] {
  return (entity.relationAggregates ?? []).map((aggregate) => ({
    name: aggregate.field,
    sourceColumn: aggregate.field,
    type: 'json' as const,
    ...(aggregate.description ? { description: aggregate.description } : {}),
    ...(aggregate.label ? { label: aggregate.label } : {}),
    searchable: aggregate.searchable,
    filterable: false,
    visible: aggregate.visible,
    sensitive: false,
    aliases: [],
    identifier: false,
  }));
}

function mergeFilters(
  extracted: NormalizedFilter[],
  requestFilters: NormalizedFilter[],
  defaults: NormalizedFilter[],
): NormalizedFilter[] {
  const byKey = new Map<string, NormalizedFilter>();
  const defaultFields = new Set(defaults.map((filter) => filter.field));

  for (const filter of [...extracted, ...requestFilters]) {
    if (defaultFields.has(filter.field)) continue;
    byKey.set(`${filter.field}:${filter.op}`, filter);
  }
  for (const filter of defaults) {
    byKey.set(`${filter.field}:${filter.op}`, filter);
  }

  return [...byKey.values()];
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
  metadata?: QueryResilienceMetadata;
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
    metadata: payload.metadata ?? {},
    error: payload.error ?? null,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
