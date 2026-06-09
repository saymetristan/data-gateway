import { and, eq, inArray } from 'drizzle-orm';
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
  findEntityForTable,
  parseSourceRecordParts,
  renderPromptTemplate,
  renderTemplate,
} from '../mapping/apply.js';
import type { MappingDocument } from '../schemas/mapping.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { LlmProvider } from '../providers/llm.js';
import { payloadHash, promptHash } from '../utils/hash.js';
import { enqueueJob } from '../queue/boss.js';
import { EMBEDDINGS_GENERATE_JOB } from '../queue/jobs.js';
import { getActiveMapping, getMappingByVersion } from './mappings.js';

const EMBEDDING_BATCH_SIZE = 50;
const RAW_BATCH_SIZE = 500;

export async function indexSource(
  db: Database,
  sourceId: string,
  workspaceId: string,
  connectionString: string,
  llmProvider: LlmProvider,
): Promise<{ indexed: number; embeddingJobs: number }> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) {
    throw GatewayError.notFound('Source not found');
  }

  const mapping = await getActiveMapping(db, sourceId);
  const document = mapping.document as MappingDocument;
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

      if (entityDef.enrichment) {
        data = await enrichRecord(db, sourceId, raw.sourceRecordId, raw.payloadHash, data, entityDef, llmProvider);
      }

      const searchSource = buildSearchSource(data, entityDef.fields);
      const dataHash = payloadHash(data);

      const [existing] = await db
        .select({
          id: records.id,
          mappingVersion: records.mappingVersion,
          searchSource: records.searchSource,
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
        })
        .onConflictDoUpdate({
          target: [records.sourceId, records.entity, records.externalId],
          set: {
            data,
            sourceRecordHash: dataHash,
            mappingVersion: mapping.version,
            searchSource,
            updatedAt: new Date(),
          },
        })
        .returning({ id: records.id, mappingVersion: records.mappingVersion, searchSource: records.searchSource });

      if (!upserted) continue;

      const shouldEmbed =
        !existing ||
        existing.mappingVersion !== mapping.version ||
        existing.searchSource !== searchSource ||
        existing.sourceRecordHash !== dataHash;

      if (shouldEmbed) {
        recordIdsForEmbedding.push(upserted.id);
        indexed += 1;
      }
    }

    if (rawRows.length < RAW_BATCH_SIZE) break;
    offset += rawRows.length;
  }

  for (let i = 0; i < recordIdsForEmbedding.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = recordIdsForEmbedding.slice(i, i + EMBEDDING_BATCH_SIZE);
    await enqueueJob(connectionString, EMBEDDINGS_GENERATE_JOB, {
      sourceId,
      workspaceId,
      recordIds: batch,
      mappingVersion: mapping.version,
    });
  }

  if (indexed > 0) {
    await db
      .update(sources)
      .set({ maturityStatus: 'indexed', updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
  }

  return {
    indexed,
    embeddingJobs: Math.ceil(recordIdsForEmbedding.length / EMBEDDING_BATCH_SIZE),
  };
}

export async function generateEmbeddingsForRecords(
  db: Database,
  sourceId: string,
  recordIds: string[],
  mappingVersion: number,
  embeddingProvider: EmbeddingProvider,
): Promise<number> {
  if (recordIds.length === 0) return 0;

  const mapping = await getMappingByVersion(db, sourceId, mappingVersion);
  const document = mapping.document as MappingDocument;
  const entityMap = new Map(document.entities.map((entity) => [entity.entity, entity]));

  const rows = await db
    .select()
    .from(records)
    .where(and(eq(records.sourceId, sourceId), inArray(records.id, recordIds)));

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
