import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  recordEmbeddings,
  recordEnrichments,
  records,
  sourceRecordsRaw,
  sources,
} from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import {
  applyFieldMapping,
  applyRules,
  buildSearchSource,
  buildWeightedSearchParts,
  findEntityForTable,
  parseSourceRecordParts,
  renderPromptTemplate,
  renderTemplate,
} from '../mapping/apply.js';
import type { MappingDocument } from '../schemas/mapping.js';
import type { MappingEntity } from '../schemas/mapping.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { LlmProvider } from '../providers/llm.js';
import { payloadHash, promptHash } from '../utils/hash.js';
import { enqueueJob } from '../queue/boss.js';
import { EMBEDDINGS_GENERATE_JOB } from '../queue/jobs.js';
import { getActiveMapping, getMappingByVersion } from './mappings.js';
import { maybeTransitionSourceMaturity } from './maturity.js';
import { toScalarString } from '../utils/scalar.js';

const EMBEDDING_BATCH_SIZE = 50;
const RAW_BATCH_SIZE = 500;

export type IndexSourceOptions = {
  invalidateMaturity?: boolean;
  embeddingModel?: string;
};

export async function indexSource(
  db: Database,
  sourceId: string,
  workspaceId: string,
  connectionString: string,
  llmProvider: LlmProvider,
  options: IndexSourceOptions = {},
): Promise<{ indexed: number; embeddingJobs: number }> {
  const invalidateMaturity = options.invalidateMaturity ?? true;
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  const mapping = await getActiveMapping(db, sourceId);
  const document = mapping.document as MappingDocument;
  const allRawRows = await db
    .select()
    .from(sourceRecordsRaw)
    .where(eq(sourceRecordsRaw.sourceId, sourceId));
  const relationIndex = buildRelationIndex(allRawRows);
  let indexed = 0;
  const recordIdsForEmbedding: string[] = [];
  let offset = 0;

  for (;;) {
    const rawRows = await db
      .select()
      .from(sourceRecordsRaw)
      .where(eq(sourceRecordsRaw.sourceId, sourceId))
      .limit(RAW_BATCH_SIZE)
      .offset(offset);
    if (rawRows.length === 0) break;

    for (const raw of rawRows) {
      const payload = raw.payload as Record<string, unknown>;
      const { table, externalId } = parseSourceRecordParts(raw.sourceRecordId);
      const tableName =
        typeof payload.__table === 'string' ? payload.__table : table;
      const entityDef = findEntityForTable(document.entities, tableName);
      if (!entityDef) continue;

      let data = applyFieldMapping(payload, entityDef.fields);
      data = applyRules(data, payload, entityDef.rules);
      const relationData = applyRelationAggregates(entityDef, payload, relationIndex);
      data = { ...data, ...relationData.data };

      if (entityDef.enrichment) {
        data = await enrichRecord(db, sourceId, raw.sourceRecordId, raw.payloadHash, data, entityDef, llmProvider);
      }

      const autoRelationText = buildAutoRelationSearchText(entityDef, payload, relationIndex);
      const weightedParts = buildWeightedSearchParts(data, entityDef.fields);
      const relationBucket = [relationData.searchText, autoRelationText]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (relationBucket) {
        weightedParts.D = [weightedParts.D, relationBucket].filter(Boolean).join(' ').trim();
      }
      const searchSource = [
        buildSearchSource(data, entityDef.fields),
        relationData.searchText,
        autoRelationText,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      const searchWeights = {
        A: weightedParts.A,
        B: weightedParts.B,
        C: weightedParts.C,
        D: weightedParts.D,
      };
      const dataHash = payloadHash(data);

      const [existing] = await db
        .select({
          id: records.id,
          mappingVersion: records.mappingVersion,
          searchSource: records.searchSource,
          searchWeights: records.searchWeights,
          sourceRecordHash: records.sourceRecordHash,
        })
        .from(records)
        .where(
          and(
            eq(records.sourceId, sourceId),
            eq(records.entity, entityDef.entity),
            eq(records.externalId, externalId),
          ),
        )
        .limit(1);

      const unchanged =
        existing !== undefined &&
        existing.mappingVersion === mapping.version &&
        existing.searchSource === searchSource &&
        JSON.stringify(existing.searchWeights ?? {}) === JSON.stringify(searchWeights) &&
        existing.sourceRecordHash === dataHash;
      if (unchanged) continue;

      const [upserted] = await db
        .insert(records)
        .values({
          workspaceId,
          sourceId,
          entity: entityDef.entity,
          externalId,
          data,
          sourceRecordHash: dataHash,
          mappingVersion: mapping.version,
          searchSource,
          searchWeights,
        })
        .onConflictDoUpdate({
          target: [records.sourceId, records.entity, records.externalId],
          set: {
            data,
            sourceRecordHash: dataHash,
            mappingVersion: mapping.version,
            searchSource,
            searchWeights,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: records.id,
          mappingVersion: records.mappingVersion,
          searchSource: records.searchSource,
        });

      if (!upserted) continue;

      recordIdsForEmbedding.push(upserted.id);
      indexed += 1;
    }

    if (rawRows.length < RAW_BATCH_SIZE) break;
    offset += rawRows.length;
  }

  const embeddingRecordIds = [...recordIdsForEmbedding];
  if (options.embeddingModel) {
    const hasPendingBackfill = await hasPendingEmbeddingJobsForSourceVersion(
      db,
      sourceId,
      mapping.version,
    );

    if (!hasPendingBackfill) {
      const missingIds = await findRecordsMissingActiveEmbeddings(
        db,
        sourceId,
        mapping.version,
        options.embeddingModel,
      );
      const seen = new Set(embeddingRecordIds);
      for (const recordId of missingIds) {
        if (!seen.has(recordId)) {
          embeddingRecordIds.push(recordId);
          seen.add(recordId);
        }
      }
    }
  }

  for (let i = 0; i < embeddingRecordIds.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = embeddingRecordIds.slice(i, i + EMBEDDING_BATCH_SIZE);
    await enqueueJob(
      connectionString,
      EMBEDDINGS_GENERATE_JOB,
      {
        sourceId,
        workspaceId,
        recordIds: batch,
        mappingVersion: mapping.version,
      },
      { singletonKey: `embeddings:${sourceId}:${String(mapping.version)}:${payloadHash(batch)}` },
    );
  }

  if (invalidateMaturity) {
    await maybeTransitionSourceMaturity(db, sourceId, 'indexed', 'source_reindexed', [
      'validated',
      'agent_ready',
    ]);
  }

  if (indexed > 0) {
    await maybeTransitionSourceMaturity(db, sourceId, 'indexed', 'source_indexed', ['mapped']);
  }

  await purgeOldEmbeddingsForSource(
    db,
    sourceId,
    mapping.version,
    options.embeddingModel,
  );

  return {
    indexed,
    embeddingJobs: Math.ceil(embeddingRecordIds.length / EMBEDDING_BATCH_SIZE),
  };
}

type RawRelationRow = {
  sourceRecordId: string;
  payload: unknown;
};

type RawPayload = Record<string, unknown>;

type RelationIndex = {
  byTable: Map<string, RawPayload[]>;
};

function buildRelationIndex(rows: RawRelationRow[]): RelationIndex {
  const byTable = new Map<string, RawPayload[]>();
  for (const row of rows) {
    const payload = row.payload as RawPayload;
    const table = typeof payload.__table === 'string'
      ? payload.__table
      : parseSourceRecordParts(row.sourceRecordId).table;
    const existing = byTable.get(table) ?? [];
    existing.push(payload);
    byTable.set(table, existing);
  }
  return { byTable };
}

function applyRelationAggregates(
  entity: MappingEntity,
  payload: RawPayload,
  relationIndex: RelationIndex,
): { data: Record<string, unknown>; searchText: string } {
  const data: Record<string, unknown> = {};
  const searchParts: string[] = [];

  for (const aggregate of entity.relationAggregates ?? []) {
    const sourceValue = toScalarString(payload[aggregate.sourceColumn]);
    if (!sourceValue) continue;
    const viaRows = (relationIndex.byTable.get(aggregate.viaTable) ?? [])
      .filter((row) => toScalarString(row[aggregate.viaSourceColumn]) === sourceValue);
    const values: string[] = [];
    for (const via of viaRows) {
      const targetValue = toScalarString(via[aggregate.viaTargetColumn]);
      if (!targetValue) continue;
      const target = (relationIndex.byTable.get(aggregate.targetTable) ?? [])
        .find((row) => toScalarString(row[aggregate.targetColumn]) === targetValue);
      if (!target) continue;
      const labelColumn = aggregate.targetLabelColumn ?? pickLabelColumn(target);
      const label = labelColumn ? toScalarString(target[labelColumn]) : targetValue;
      if (label) values.push(label);
    }

    const unique = [...new Set(values)];
    if (unique.length === 0) continue;
    data[aggregate.field] = unique;
    if (aggregate.searchable) {
      searchParts.push(...unique);
    }
  }

  return { data, searchText: searchParts.join(' ') };
}

function buildAutoRelationSearchText(
  entity: MappingEntity,
  payload: RawPayload,
  relationIndex: RelationIndex,
): string {
  const sourceTable = entity.sourceTable;
  const sourcePk = primaryKeyValue(payload);
  if (!sourcePk) return '';

  const labels: string[] = [];
  for (const rows of relationIndex.byTable.values()) {
    const sample = rows[0];
    if (!sample || sample.__tableRole !== 'junction') continue;
    const foreignKeys = readForeignKeys(sample);
    const sourceFk = foreignKeys.find((fk) => fk.referencedTable === sourceTable);
    if (!sourceFk) continue;
    const targetFk = foreignKeys.find((fk) => fk !== sourceFk);
    if (!targetFk) continue;

    for (const row of rows) {
      if (toScalarString(row[sourceFk.column]) !== sourcePk) continue;
      const targetValue = toScalarString(row[targetFk.column]);
      const target = (relationIndex.byTable.get(targetFk.referencedTable) ?? [])
        .find((item) => toScalarString(item[targetFk.referencedColumn]) === targetValue);
      if (!target) continue;
      const labelColumn = pickLabelColumn(target);
      const label = labelColumn ? toScalarString(target[labelColumn]) : targetValue;
      if (label) labels.push(label);
    }
  }

  return [...new Set(labels)].join(' ');
}

function primaryKeyValue(payload: RawPayload): string {
  const primaryKey = Array.isArray(payload.__primaryKey)
    ? payload.__primaryKey.filter((value): value is string => typeof value === 'string')
    : [];
  const key = primaryKey[0];
  return key ? toScalarString(payload[key]) : '';
}

function pickLabelColumn(payload: RawPayload): string | null {
  const candidates = ['nombre', 'name', 'titulo', 'title', 'descripcion', 'description', 'sku'];
  return candidates.find((candidate) => payload[candidate] !== undefined && payload[candidate] !== null) ?? null;
}

function readForeignKeys(payload: RawPayload): Array<{
  column: string;
  referencedTable: string;
  referencedColumn: string;
}> {
  if (!Array.isArray(payload.__foreignKeys)) return [];
  return payload.__foreignKeys.filter((value): value is {
    column: string;
    referencedTable: string;
    referencedColumn: string;
  } => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return (
      typeof item.column === 'string' &&
      typeof item.referencedTable === 'string' &&
      typeof item.referencedColumn === 'string'
    );
  });
}

export async function findRecordsMissingActiveEmbeddings(
  db: Database,
  sourceId: string,
  mappingVersion: number,
  embeddingModel: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: records.id })
    .from(records)
    .leftJoin(
      recordEmbeddings,
      and(
        eq(recordEmbeddings.recordId, records.id),
        eq(recordEmbeddings.embeddingModel, embeddingModel),
        eq(recordEmbeddings.mappingVersion, mappingVersion),
      ),
    )
    .where(
      and(
        eq(records.sourceId, sourceId),
        eq(records.mappingVersion, mappingVersion),
        sql`${recordEmbeddings.id} IS NULL`,
      ),
    );

  return rows.map((row) => row.id);
}

async function hasPendingEmbeddingJobsForSourceVersion(
  db: Database,
  sourceId: string,
  mappingVersion: number,
): Promise<boolean> {
  try {
    const result = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM pgboss.job
      WHERE name = ${EMBEDDINGS_GENERATE_JOB}
        AND state IN ('created', 'active', 'retry')
        AND data->>'sourceId' = ${sourceId}
        AND data->>'mappingVersion' = ${String(mappingVersion)}
    `);
    return Number(result.rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function purgeOldEmbeddingsForSource(
  db: Database,
  sourceId: string,
  activeMappingVersion: number,
  activeEmbeddingModel?: string,
): Promise<void> {
  const staleVersionRows = await db
    .select({ embeddingId: recordEmbeddings.id })
    .from(recordEmbeddings)
    .innerJoin(records, eq(records.id, recordEmbeddings.recordId))
    .where(
      and(
        eq(records.sourceId, sourceId),
        sql`${recordEmbeddings.mappingVersion} <> ${activeMappingVersion}`,
        sql`EXISTS (
          SELECT 1 FROM record_embeddings AS active_emb
          WHERE active_emb.record_id = ${recordEmbeddings.recordId}
            AND active_emb.mapping_version = ${activeMappingVersion}
        )`,
      ),
    );

  const idsToDelete = staleVersionRows.map((row) => row.embeddingId);

  if (activeEmbeddingModel) {
    const staleModelRows = await db
      .select({ embeddingId: recordEmbeddings.id })
      .from(recordEmbeddings)
      .innerJoin(records, eq(records.id, recordEmbeddings.recordId))
      .where(
        and(
          eq(records.sourceId, sourceId),
          sql`${recordEmbeddings.embeddingModel} <> ${activeEmbeddingModel}`,
          sql`EXISTS (
            SELECT 1 FROM record_embeddings AS active_emb
            WHERE active_emb.record_id = ${recordEmbeddings.recordId}
              AND active_emb.embedding_model = ${activeEmbeddingModel}
              AND active_emb.mapping_version = ${activeMappingVersion}
          )`,
        ),
      );
    idsToDelete.push(...staleModelRows.map((row) => row.embeddingId));
  }

  const uniqueIds = [...new Set(idsToDelete)];
  if (uniqueIds.length === 0) return;
  await db.delete(recordEmbeddings).where(inArray(recordEmbeddings.id, uniqueIds));
}

export async function generateEmbeddingsForRecords(
  db: Database,
  sourceId: string,
  recordIds: string[],
  mappingVersion: number,
  embeddingProvider: EmbeddingProvider,
): Promise<number> {
  if (recordIds.length === 0) return 0;

  const existingEmbeddings = await db
    .select({ recordId: recordEmbeddings.recordId })
    .from(recordEmbeddings)
    .where(
      and(
        inArray(recordEmbeddings.recordId, recordIds),
        eq(recordEmbeddings.embeddingModel, embeddingProvider.model),
        eq(recordEmbeddings.mappingVersion, mappingVersion),
      ),
    );
  const alreadyEmbedded = new Set(existingEmbeddings.map((row) => row.recordId));
  const missingRecordIds = recordIds.filter((recordId) => !alreadyEmbedded.has(recordId));
  if (missingRecordIds.length === 0) return 0;

  const mapping = await getMappingByVersion(db, sourceId, mappingVersion);
  const document = mapping.document as MappingDocument;
  const entityMap = new Map(document.entities.map((entity) => [entity.entity, entity]));

  const rows = await db
    .select()
    .from(records)
    .where(and(eq(records.sourceId, sourceId), inArray(records.id, missingRecordIds)));

  const texts: string[] = [];
  const targets: typeof rows = [];

  for (const row of rows) {
    const entityDef = entityMap.get(row.entity);
    if (!entityDef) continue;
    const data = row.data as Record<string, unknown>;
    const fieldNames = entityDef.fields.map((field) => field.name);
    const text = renderTemplate(entityDef.embeddingTextTemplate, data, fieldNames);
    texts.push(text);
    targets.push(row);
  }

  const vectors = await embeddingProvider.embed(texts);
  let written = 0;

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const vector = vectors[i];
    if (!row || !vector) continue;

    await db
      .insert(recordEmbeddings)
      .values({
        recordId: row.id,
        embedding: vector,
        embeddingModel: embeddingProvider.model,
        embeddingDims: embeddingProvider.dimensions,
        mappingVersion,
      })
      .onConflictDoUpdate({
        target: [
          recordEmbeddings.recordId,
          recordEmbeddings.embeddingModel,
          recordEmbeddings.mappingVersion,
        ],
        set: {
          embedding: vector,
          updatedAt: new Date(),
        },
      });

    written += 1;
  }

  await purgeOldEmbeddingsForSource(
    db,
    sourceId,
    mappingVersion,
    embeddingProvider.model,
  );

  return written;
}

async function enrichRecord(
  db: Database,
  sourceId: string,
  sourceRecordId: string,
  payloadHashValue: string,
  data: Record<string, unknown>,
  entityDef: MappingDocument['entities'][number],
  llmProvider: LlmProvider,
): Promise<Record<string, unknown>> {
  const enrichment = entityDef.enrichment;
  if (!enrichment) return data;

  const prompt = renderPromptTemplate(enrichment.prompt, data, enrichment.inputFields);
  const hash = promptHash(prompt);

  const [hit] = await db
    .select()
    .from(recordEnrichments)
    .where(
      and(
        eq(recordEnrichments.sourceId, sourceId),
        eq(recordEnrichments.sourceRecordId, sourceRecordId),
        eq(recordEnrichments.payloadHash, payloadHashValue),
        eq(recordEnrichments.promptHash, hash),
      ),
    )
    .limit(1);

  let output: Record<string, unknown>;
  if (hit) {
    output = hit.output as Record<string, unknown>;
  } else {
    const completion = await llmProvider.complete(
      `${prompt}\n\nRespond only with valid JSON.`,
    );
    const jsonText = extractJson(completion);
    const schema = buildEnrichmentSchema(enrichment.outputFields);
    output = schema.parse(JSON.parse(jsonText));

    await db
      .insert(recordEnrichments)
      .values({
        sourceId,
        sourceRecordId,
        payloadHash: payloadHashValue,
        promptHash: hash,
        output,
      })
      .onConflictDoNothing({
        target: [
          recordEnrichments.sourceId,
          recordEnrichments.sourceRecordId,
          recordEnrichments.payloadHash,
          recordEnrichments.promptHash,
        ],
      });
  }

  return { ...data, ...output };
}

function buildEnrichmentSchema(
  outputFields: NonNullable<MappingDocument['entities'][number]['enrichment']>['outputFields'],
) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of outputFields) {
    switch (field.type) {
      case 'number':
        shape[field.name] = z.number();
        break;
      case 'boolean':
        shape[field.name] = z.boolean();
        break;
      case 'date':
        shape[field.name] = z.string();
        break;
      default:
        shape[field.name] = z.string();
    }
  }
  return z.object(shape);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}
