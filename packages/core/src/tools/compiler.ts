import type { MappingEntity, MappingField } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import type { ToolDefinition, ToolKind } from '../schemas/tools.js';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const ENUM_MAX_CARDINALITY = 20;
const ENUM_MAX_TOP_VALUES = 20;

export type CompileToolsInput = {
  entity: MappingEntity;
  profile: SourceProfileDocument;
  mappingVersion: number;
  sourceIds: string[];
  workspaceName?: string;
};

type FilterableTarget = {
  name: string;
  type: MappingField['type'];
  sourceColumn?: string | undefined;
  description?: string | undefined;
  fromRule?: boolean | undefined;
};

export function compileToolsForEntity(input: CompileToolsInput): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const searchTool = buildSearchTool(input);
  if (searchTool) tools.push(searchTool);

  const availabilityTool = buildCheckAvailabilityTool(input);
  if (availabilityTool) tools.push(availabilityTool);

  return tools;
}

export function mergeToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  const merged = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    const existing = merged.get(tool.name);
    if (!existing) {
      merged.set(tool.name, { ...tool, sourceIds: [...tool.sourceIds] });
      continue;
    }

    const sourceIds = [...new Set([...existing.sourceIds, ...tool.sourceIds])];
    merged.set(tool.name, {
      ...existing,
      sourceIds,
      mappingVersion: Math.max(existing.mappingVersion, tool.mappingVersion),
      inputSchema: mergeInputSchemas(existing.inputSchema, tool.inputSchema),
    });
  }

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function mergeInputSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const leftProperties = (left.properties ?? {}) as Record<string, Record<string, unknown>>;
  const rightProperties = (right.properties ?? {}) as Record<string, Record<string, unknown>>;
  const properties: Record<string, unknown> = { ...leftProperties };

  for (const [name, rightProperty] of Object.entries(rightProperties)) {
    const leftProperty = leftProperties[name];
    properties[name] = leftProperty
      ? mergeJsonSchemaProperty(leftProperty, rightProperty)
      : rightProperty;
  }

  return {
    ...left,
    properties,
    required: mergeRequired(left.required, right.required),
  };
}

function mergeJsonSchemaProperty(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };

  if (Array.isArray(left.enum) || Array.isArray(right.enum)) {
    const values = [...enumValues(left.enum), ...enumValues(right.enum)];
    if (values.length > 0 && values.length <= ENUM_MAX_TOP_VALUES) {
      merged.enum = [...new Set(values)];
    } else {
      delete merged.enum;
    }
  }

  if (typeof left.minimum === 'number' || typeof right.minimum === 'number') {
    merged.minimum = Math.min(
      typeof left.minimum === 'number' ? left.minimum : Number.POSITIVE_INFINITY,
      typeof right.minimum === 'number' ? right.minimum : Number.POSITIVE_INFINITY,
    );
  }
  if (typeof left.maximum === 'number' || typeof right.maximum === 'number') {
    merged.maximum = Math.max(
      typeof left.maximum === 'number' ? left.maximum : Number.NEGATIVE_INFINITY,
      typeof right.maximum === 'number' ? right.maximum : Number.NEGATIVE_INFINITY,
    );
  }

  return merged;
}

function enumValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function mergeRequired(left: unknown, right: unknown): string[] {
  const leftValues = Array.isArray(left) ? left.map((item) => String(item)) : [];
  const rightValues = Array.isArray(right) ? right.map((item) => String(item)) : [];
  return [...new Set([...leftValues, ...rightValues])];
}

export function slugifyToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildSearchTool(input: CompileToolsInput): ToolDefinition | null {
  const targets = getFilterableTargets(input.entity);
  if (targets.length === 0) return null;

  const profileColumns = profileColumnsForEntity(input.entity, input.profile);
  const properties: Record<string, unknown> = {
    query: {
      type: 'string',
      description: 'Texto libre de búsqueda',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10,
      description: 'Cantidad máxima de resultados',
    },
  };
  const required: string[] = [];

  for (const target of targets) {
    const column = target.sourceColumn
      ? profileColumns.get(target.sourceColumn)
      : profileColumns.get(target.name);

    if (target.type === 'number' || target.type === 'date') {
      const minKey = `${target.name}_min`;
      const maxKey = `${target.name}_max`;
      const minSchema: Record<string, unknown> = {
        type: target.type === 'date' ? 'string' : 'number',
        description: target.description ?? `Mínimo para ${target.name}`,
      };
      const maxSchema: Record<string, unknown> = {
        type: target.type === 'date' ? 'string' : 'number',
        description: target.description ?? `Máximo para ${target.name}`,
      };
      if (column?.min !== undefined) minSchema.minimum = column.min;
      if (column?.max !== undefined) maxSchema.maximum = column.max;
      properties[minKey] = minSchema;
      properties[maxKey] = maxSchema;
      continue;
    }

    if (target.type === 'boolean') {
      properties[target.name] = {
        type: 'boolean',
        description: target.description ?? `Filtrar por ${target.name}`,
      };
      continue;
    }

    const enumValues = buildEnumValues(column);
    properties[target.name] = enumValues
      ? {
          type: 'string',
          enum: enumValues,
          description: target.description ?? `Filtrar por ${target.name}`,
        }
      : {
          type: 'string',
          description: target.description ?? `Filtrar por ${target.name}`,
        };
  }

  const entitySlug = slugifyToolName(input.entity.entity);
  const filterNames = targets.map((target) => target.name);
  return {
    name: `search_${entitySlug}`,
    kind: 'search',
    description: buildSearchDescription(input, filterNames),
    entity: input.entity.entity,
    sourceIds: [...input.sourceIds],
    mappingVersion: input.mappingVersion,
    inputSchema: {
      $schema: JSON_SCHEMA_DRAFT,
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    },
    outputHints: {
      returns: 'search_results',
    },
  };
}

function buildCheckAvailabilityTool(input: CompileToolsInput): ToolDefinition | null {
  const booleanTargets = getFilterableTargets(input.entity).filter((target) => target.type === 'boolean');
  if (booleanTargets.length === 0) return null;

  const identifier = pickIdentifierField(input.entity);
  if (!identifier) return null;

  const entitySlug = slugifyToolName(input.entity.entity);
  const properties: Record<string, unknown> = {
    [identifier.name]: {
      type: 'string',
      description: identifier.description ?? `Identificador (${identifier.name})`,
    },
  };

  return {
    name: `check_availability_${entitySlug}`,
    kind: 'check_availability',
    description: buildAvailabilityDescription(input, identifier.name),
    entity: input.entity.entity,
    sourceIds: [...input.sourceIds],
    mappingVersion: input.mappingVersion,
    inputSchema: {
      $schema: JSON_SCHEMA_DRAFT,
      type: 'object',
      additionalProperties: false,
      properties,
      required: [identifier.name],
    },
    outputHints: {
      returns: 'availability_check',
      availabilityField: booleanTargets[0]?.name ?? 'available',
    },
  };
}

function buildSearchDescription(input: CompileToolsInput, filterNames: string[]): string {
  const entityLabel = input.entity.description ?? input.entity.entity;
  const workspaceSuffix = input.workspaceName ? ` en ${input.workspaceName}` : '';
  const filters = filterNames.length > 0 ? filterNames.join(', ') : 'los filtros disponibles';
  return [
    `Busca ${entityLabel}${workspaceSuffix} usando texto libre y filtros estructurados (${filters}).`,
    `When to use: cuando el cliente quiere encontrar, comparar o filtrar ${input.entity.entity} por características, identificadores, disponibilidad o precio.`,
    'Never use for: modificar datos, confirmar compras, reservar, cobrar, cancelar pedidos o prometer disponibilidad sin resultados de la herramienta.',
    'Success criteria: ok=true, status=success y data.results contiene resultados relevantes; usa los campos devueltos como fuente de verdad.',
    'Fallback: si status=needs_more_info o no hay resultados, pide más detalle al cliente en vez de inventar datos.',
  ].join('\n');
}

function buildAvailabilityDescription(input: CompileToolsInput, identifierName: string): string {
  const entityLabel = input.entity.description ?? input.entity.entity;
  const workspaceSuffix = input.workspaceName ? ` en ${input.workspaceName}` : '';
  return [
    `Verifica disponibilidad de ${entityLabel}${workspaceSuffix} por ${identifierName}.`,
    `When to use: cuando el cliente pregunta si un ${input.entity.entity} específico está disponible o en stock y ya hay un identificador como ${identifierName}.`,
    `Never use for: búsquedas amplias sin identificador; en ese caso usa search_${slugifyToolName(input.entity.entity)} primero.`,
    'Success criteria: ok=true, status=success y data contiene el estado de disponibilidad del registro consultado.',
    'Fallback: si falta identificador o no hay coincidencia, pide SKU, nombre exacto u otro dato verificable.',
  ].join('\n');
}

function getFilterableTargets(entity: MappingEntity): FilterableTarget[] {
  const targets: FilterableTarget[] = [];
  const seen = new Set<string>();

  for (const field of entity.fields) {
    if (!field.filterable || field.sensitive) continue;
    targets.push({
      name: field.name,
      type: field.type,
      sourceColumn: field.sourceColumn,
      ...(field.description ? { description: field.description } : {}),
    });
    seen.add(field.name);
  }

  for (const rule of entity.rules) {
    if (seen.has(rule.field)) continue;
    targets.push({
      name: rule.field,
      type: 'boolean',
      fromRule: true,
      description: `Campo derivado ${rule.field}`,
    });
    seen.add(rule.field);
  }

  for (const filter of entity.defaultFilters) {
    if (seen.has(filter.field)) continue;
    const inferredType =
      typeof filter.value === 'boolean'
        ? 'boolean'
        : typeof filter.value === 'number'
          ? 'number'
          : 'string';
    targets.push({
      name: filter.field,
      type: inferredType,
      fromRule: true,
      description: `Campo con filtro por defecto ${filter.field}`,
    });
    seen.add(filter.field);
  }

  return targets;
}

function pickIdentifierField(entity: MappingEntity): MappingField | null {
  const candidates = entity.fields.filter(
    (field) => field.filterable && !field.sensitive && field.type === 'string',
  );
  const sku = candidates.find((field) => field.name.toLowerCase() === 'sku');
  if (sku) return sku;
  return candidates[0] ?? null;
}

function buildEnumValues(column: ProfileColumn | undefined): string[] | null {
  if (!column) return null;
  if (column.cardinality > ENUM_MAX_CARDINALITY) return null;
  const values = column.topValues
    .slice(0, ENUM_MAX_TOP_VALUES)
    .map((item) => item.value)
    .filter((value) => value !== null)
    .map((value) => String(value));
  if (values.length === 0) return null;
  return [...new Set(values)];
}

function profileColumnsForEntity(
  entity: MappingEntity,
  profile: SourceProfileDocument,
): Map<string, ProfileColumn> {
  const table = profile.tables.find((item) => item.table === entity.sourceTable);
  const map = new Map<string, ProfileColumn>();
  if (!table) return map;
  for (const column of table.columns) {
    map.set(column.name, column);
  }
  return map;
}

export function toolKindFromName(name: string): ToolKind | null {
  if (name.startsWith('search_')) return 'search';
  if (name.startsWith('check_availability_')) return 'check_availability';
  return null;
}
