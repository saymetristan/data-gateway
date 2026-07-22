import type { MappingEntity, MappingField } from '../schemas/mapping.js';
import type { ProfileColumn, SourceProfileDocument } from '../schemas/profile.js';
import type { ToolDefinition, ToolKind } from '../schemas/tools.js';
import {
  describeTarget,
  entityLabel,
  fieldLabel,
  getFilterableTargets,
  pickIdentifierField,
  profileColumnsForEntity,
} from '../mapping/metadata.js';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const ENUM_MAX_CARDINALITY = 50;
const ENUM_MAX_TOP_VALUES = 20;

export type CompileToolsInput = {
  entity: MappingEntity;
  profile: SourceProfileDocument;
  mappingVersion: number;
  sourceIds: string[];
  workspaceName?: string;
  sourceName?: string;
};

export function compileToolsForEntity(input: CompileToolsInput): ToolDefinition[] {
  if (input.entity.sourceKind === 'junction' && input.entity.exposeAsTool !== true) {
    return [];
  }

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
      description: mergeDescriptions(existing.description, tool.description),
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
      const unique = [...new Set(values)];
      merged.enum = unique.slice(0, ENUM_MAX_TOP_VALUES);
      merged.description = appendDescription(
        merged.description,
        `Valores disponibles truncados a ${String(ENUM_MAX_TOP_VALUES)} de ${String(unique.length)} detectados.`,
      );
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

function mergeDescriptions(left: string, right: string): string {
  if (left === right || left.includes(right)) return left;
  return `${left}\nTambién aplica a: ${right.split('\n')[0] ?? right}`;
}

function appendDescription(value: unknown, addition: string): string {
  const base = typeof value === 'string' ? value.trim() : '';
  return base ? `${base} ${addition}` : addition;
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
        title: `${target.filterLabel} mínimo`,
        description: describeRangeTarget(target, 'mínimo'),
      };
      const maxSchema: Record<string, unknown> = {
        type: target.type === 'date' ? 'string' : 'number',
        title: `${target.filterLabel} máximo`,
        description: describeRangeTarget(target, 'máximo'),
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
        title: target.filterLabel,
        description: describeTarget(target),
      };
      continue;
    }

    const enumValues = buildEnumValues(column);
    const retrieval = target.retrieval;
    const match = retrieval?.match ?? (retrieval?.cardinality === 'many' ? 'contains' : 'eq');
    const asPreference = retrieval?.inferredBehavior === 'prefer';
    const isMany = retrieval?.cardinality === 'many';
    const boost = retrieval?.boost;
    const gatewayMeta = {
      match,
      asPreference: false,
      ...(boost !== undefined ? { boost } : {}),
    };

    if (isMany) {
      properties[target.name] = {
        type: 'array',
        items: {
          type: 'string',
          ...(enumValues ? { enum: enumValues } : {}),
        },
        title: target.filterLabel,
        description: describeEnumTarget(target, column, enumValues ?? []),
        'x-gateway': gatewayMeta,
      };
    } else {
      properties[target.name] = {
        type: 'string',
        ...(enumValues ? { enum: enumValues } : {}),
        title: target.filterLabel,
        description: describeEnumTarget(target, column, enumValues ?? []),
        'x-gateway': gatewayMeta,
      };
    }

    if (asPreference) {
      properties[`prefer_${target.name}`] = {
        type: isMany ? 'array' : 'string',
        ...(isMany
          ? {
              items: {
                type: 'string',
                ...(enumValues ? { enum: enumValues } : {}),
              },
            }
          : enumValues
            ? { enum: enumValues }
            : {}),
        title: `Preferir ${target.filterLabel}`,
        description: `Prioriza resultados con este ${target.filterLabel} sin excluir otros.`,
        'x-gateway': {
          match,
          asPreference: true,
          ...(boost !== undefined ? { boost } : {}),
        },
      };
    }
  }

  const entitySlug = slugifyToolName(input.entity.entity);
  const filterNames = targets.map((target) => target.filterLabel);
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
      title: fieldLabel(identifier),
      description: identifier.description ?? `Identificador (${fieldLabel(identifier)})`,
    },
  };

  return {
    name: `check_availability_${entitySlug}`,
    kind: 'check_availability',
    description: buildAvailabilityDescription(input, identifier),
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
  const label = entityLabel(input.entity);
  const context = [input.workspaceName, input.sourceName].filter(Boolean).join(' / ');
  const workspaceSuffix = context ? ` en ${context}` : '';
  const filters = filterNames.length > 0 ? filterNames.join(', ') : 'los filtros disponibles';
  return [
    `Busca ${label}${workspaceSuffix} usando texto libre y filtros estructurados (${filters}).`,
    `When to use: cuando el cliente quiere encontrar, comparar o filtrar ${label} por características, identificadores, disponibilidad o precio.`,
    'Never use for: modificar datos, confirmar compras, reservar, cobrar, cancelar pedidos o prometer disponibilidad sin resultados de la herramienta.',
    'Success criteria: ok=true, status=success, data.results relevantes y confidence calibrada aceptable; usa los campos devueltos como fuente de verdad.',
    'Fallback: si status=needs_more_info (vacío o coincidencias débiles), pide un término exacto (nombre de tela/SKU) o reintenta con ese término; no inventes datos ni asumas que una lista no vacía es correcta.',
  ].join('\n');
}

function buildAvailabilityDescription(input: CompileToolsInput, identifier: MappingField): string {
  const label = entityLabel(input.entity);
  const identifierName = fieldLabel(identifier);
  const context = [input.workspaceName, input.sourceName].filter(Boolean).join(' / ');
  const workspaceSuffix = context ? ` en ${context}` : '';
  return [
    `Verifica disponibilidad de ${label}${workspaceSuffix} por ${identifierName}.`,
    `When to use: cuando el cliente pregunta si un ${label} específico está disponible o en stock y ya hay un identificador como ${identifierName}.`,
    `Never use for: búsquedas amplias sin identificador; en ese caso usa search_${slugifyToolName(input.entity.entity)} primero.`,
    'Success criteria: ok=true, status=success y data contiene el estado de disponibilidad del registro consultado.',
    'Fallback: si falta identificador o no hay coincidencia, pide SKU, nombre exacto u otro dato verificable.',
  ].join('\n');
}

function buildEnumValues(column: ProfileColumn | undefined): string[] | null {
  if (!column) return null;
  if (column.inferredType === 'json') return null;
  if (column.cardinality > ENUM_MAX_CARDINALITY) return null;
  const values = (column.suggestedValues ?? column.topValues)
    .slice(0, ENUM_MAX_TOP_VALUES)
    .map((item) => item.value)
    .filter((value) => value !== null)
    .map((value) => String(value));
  if (values.length === 0) return null;
  return [...new Set(values)];
}

function describeRangeTarget(
  target: ReturnType<typeof getFilterableTargets>[number],
  bound: 'mínimo' | 'máximo',
): string {
  const base = target.description ?? `Filtrar por ${target.filterLabel}`;
  const unit = target.unit ? ` Unidad: ${target.unit}.` : '';
  return `${base} Usa este parámetro para el valor ${bound}.${unit}`;
}

function describeEnumTarget(
  target: ReturnType<typeof getFilterableTargets>[number],
  column: ProfileColumn | undefined,
  enumValues: string[],
): string {
  const parts = [describeTarget(target)];
  const suggested = (column?.suggestedValues ?? column?.topValues ?? [])
    .map((item) => item.value)
    .filter((value) => value !== null)
    .map((value) => String(value));
  if (enumValues.length > 0) {
    parts.push(`Valores permitidos: ${enumValues.join(', ')}.`);
  } else if (suggested.length > 0) {
    parts.push(`Valores frecuentes: ${suggested.slice(0, ENUM_MAX_TOP_VALUES).join(', ')}.`);
  }
  if (column && column.cardinality > ENUM_MAX_CARDINALITY) {
    parts.push(
      `Alta cardinalidad (${String(column.cardinality)} valores); acepta texto exacto si no aparece en sugerencias.`,
    );
  }
  return parts.join(' ');
}

export function toolKindFromName(name: string): ToolKind | null {
  if (name.startsWith('search_')) return 'search';
  if (name.startsWith('check_availability_')) return 'check_availability';
  return null;
}
