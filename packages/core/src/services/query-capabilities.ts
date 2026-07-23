import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { GatewayError } from '../errors/gateway-error.js';
import {
  fieldLabel,
  filterLabel,
  getFilterableTargets,
  profileColumnsForEntity,
} from '../mapping/metadata.js';
import { getFieldRetrieval, type MappingDocument, type MappingField } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import type {
  QueryCapabilitiesResponse,
  QueryEntityCapability,
  QueryFieldCapability,
} from '../schemas/query-capabilities.js';
import { operatorsForField } from '../query/validate-filters.js';
import { getActiveMapping } from './mappings.js';
import { getSourceProfile } from './profile.js';

const QUERYABLE_MATURITY = new Set(['indexed', 'validated', 'agent_ready']);
const SUGGESTED_VALUES_LIMIT = 50;

export type GetQueryCapabilitiesInput = {
  db: Database;
  workspaceId: string;
  entity?: string;
  sourceId?: string;
};

export async function getQueryCapabilities(
  input: GetQueryCapabilitiesInput,
): Promise<QueryCapabilitiesResponse> {
  const warnings: string[] = [];
  const rows = await input.db
    .select()
    .from(sources)
    .where(
      input.sourceId
        ? and(eq(sources.workspaceId, input.workspaceId), eq(sources.id, input.sourceId))
        : eq(sources.workspaceId, input.workspaceId),
    );

  if (input.sourceId && rows.length === 0) {
    throw GatewayError.notFound('Source not found');
  }

  type SourceBundle = {
    id: string;
    mappingVersion: number;
    document: MappingDocument;
    profile: SourceProfileDocument;
  };

  const bundles: SourceBundle[] = [];
  for (const source of rows) {
    if (!QUERYABLE_MATURITY.has(source.maturityStatus)) continue;
    try {
      const mapping = await getActiveMapping(input.db, source.id);
      const profile = await getSourceProfile(input.db, source.id);
      bundles.push({
        id: source.id,
        mappingVersion: mapping.version,
        document: mapping.document as MappingDocument,
        profile,
      });
    } catch {
      warnings.push(`Source ${source.id} skipped: missing active mapping or profile`);
    }
  }

  const entitiesByName = new Map<string, QueryEntityCapability>();

  for (const bundle of bundles) {
    for (const entity of bundle.document.entities) {
      if (input.entity && entity.entity !== input.entity) continue;

      const existing = entitiesByName.get(entity.entity);
      const fields = buildFieldCapabilities(entity.fields, entity, bundle.profile);
      if (!existing) {
        entitiesByName.set(entity.entity, {
          entity: entity.entity,
          ...(entity.displayName ? { displayName: entity.displayName } : {}),
          ...(entity.description ? { description: entity.description } : {}),
          sourceIds: [bundle.id],
          mappingVersion: bundle.mappingVersion,
          fields,
        });
        continue;
      }

      existing.sourceIds = [...new Set([...existing.sourceIds, bundle.id])];
      existing.mappingVersion = Math.max(existing.mappingVersion, bundle.mappingVersion);
      existing.fields = mergeFieldCapabilities(existing.fields, fields);
    }
  }

  if (input.entity && entitiesByName.size === 0) {
    throw GatewayError.notFound(`Entity "${input.entity}" not found in queryable sources`);
  }

  return {
    workspaceId: input.workspaceId,
    generatedAt: new Date().toISOString(),
    entities: [...entitiesByName.values()].sort((a, b) => a.entity.localeCompare(b.entity)),
    warnings,
  };
}

function buildFieldCapabilities(
  fields: MappingField[],
  entity: MappingDocument['entities'][number],
  profile: SourceProfileDocument,
): QueryFieldCapability[] {
  const profileColumns = profileColumnsForEntity(entity, profile);
  const targets = getFilterableTargets(entity);
  const capabilities: QueryFieldCapability[] = [];

  for (const target of targets) {
    const field = fields.find((item) => item.name === target.name);
    // Rules/defaultFilters can introduce boolean targets without a backing field.
    const syntheticField: MappingField = field ?? {
      name: target.name,
      sourceColumn: target.sourceColumn ?? target.name,
      type: target.type,
      searchable: false,
      filterable: true,
      visible: true,
      sensitive: false,
      aliases: target.aliases,
    };
    if (syntheticField.sensitive || !syntheticField.visible) continue;

    const retrieval = getFieldRetrieval(syntheticField);
    const column = resolveProfileColumn(syntheticField, profileColumns);
    const suggested = collectSuggestedValues(column, retrieval.cardinality === 'many');
    const preferable =
      retrieval.inferredBehavior === 'prefer' || syntheticField.filterable;

    capabilities.push({
      field: syntheticField.name,
      label: fieldLabel(syntheticField),
      filterLabel: filterLabel(syntheticField),
      type: syntheticField.type,
      aliases: syntheticField.aliases ?? [],
      ...(syntheticField.description ? { description: syntheticField.description } : {}),
      cardinality: retrieval.cardinality,
      operators: operatorsForField(syntheticField),
      filterable: Boolean(syntheticField.filterable || target.fromRule),
      preferable,
      inferredBehavior: retrieval.inferredBehavior,
      match: retrieval.match,
      boost: retrieval.boost,
      ...(column?.min !== undefined ? { min: column.min } : {}),
      ...(column?.max !== undefined ? { max: column.max } : {}),
      suggestedValues: suggested.values,
      suggestedValuesTruncated: suggested.truncated,
    });
  }

  return capabilities.sort((a, b) => a.field.localeCompare(b.field));
}

function resolveProfileColumn(
  field: MappingField,
  profileColumns: Map<string, ProfileColumn>,
): ProfileColumn | undefined {
  return (
    profileColumns.get(field.sourceColumn) ??
    profileColumns.get(field.name)
  );
}

export function collectSuggestedValues(
  column: ProfileColumn | undefined,
  preferAtomic: boolean,
): { values: Array<{ value: string | number | boolean; displayValue?: string; count: number }>; truncated: boolean } {
  if (!column) return { values: [], truncated: false };

  if (preferAtomic && column.atomicValues && column.atomicValues.length > 0) {
    const values = column.atomicValues.slice(0, SUGGESTED_VALUES_LIMIT).map((item) => ({
      value: item.value,
      ...(item.displayValue ? { displayValue: item.displayValue } : {}),
      count: item.count,
    }));
    return {
      values,
      truncated: Boolean(column.atomicValuesTruncated) || column.atomicValues.length > SUGGESTED_VALUES_LIMIT,
    };
  }

  const source = column.suggestedValues ?? column.topValues;
  const values = source
    .slice(0, SUGGESTED_VALUES_LIMIT)
    .map((item) => item.value)
    .filter((value): value is string | number | boolean => value !== null)
    .map((value, index) => ({
      value,
      count: source[index]?.count ?? 0,
    }));

  return {
    values,
    truncated: source.length > SUGGESTED_VALUES_LIMIT || Boolean(column.atomicValuesTruncated),
  };
}

function mergeFieldCapabilities(
  left: QueryFieldCapability[],
  right: QueryFieldCapability[],
): QueryFieldCapability[] {
  const byName = new Map(left.map((field) => [field.field, field]));
  for (const field of right) {
    const existing = byName.get(field.field);
    if (!existing) {
      byName.set(field.field, field);
      continue;
    }
    const suggested = [...existing.suggestedValues, ...field.suggestedValues];
    const deduped = new Map<string, (typeof suggested)[number]>();
    for (const item of suggested) {
      const key = String(item.value);
      const prior = deduped.get(key);
      if (!prior || item.count > prior.count) deduped.set(key, item);
    }
    byName.set(field.field, {
      ...existing,
      aliases: [...new Set([...existing.aliases, ...field.aliases])],
      operators: [...new Set([...existing.operators, ...field.operators])],
      suggestedValues: [...deduped.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, SUGGESTED_VALUES_LIMIT),
      suggestedValuesTruncated:
        existing.suggestedValuesTruncated ||
        field.suggestedValuesTruncated ||
        deduped.size > SUGGESTED_VALUES_LIMIT,
      ...(existing.min === undefined && field.min !== undefined ? { min: field.min } : {}),
      ...(existing.max === undefined && field.max !== undefined ? { max: field.max } : {}),
      ...(typeof existing.min === 'number' && typeof field.min === 'number'
        ? { min: Math.min(existing.min, field.min) }
        : {}),
      ...(typeof existing.max === 'number' && typeof field.max === 'number'
        ? { max: Math.max(existing.max, field.max) }
        : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.field.localeCompare(b.field));
}

