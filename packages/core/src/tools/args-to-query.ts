import type { FilterOp, NormalizedFilter, QueryRequest } from '../schemas/query.js';
import type { ToolDefinition } from '../schemas/tools.js';

export type ToolQueryTranslation = {
  request: QueryRequest;
  presetFilters: NormalizedFilter[];
};

export function toolArgsToQuery(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): ToolQueryTranslation {
  const properties = (tool.inputSchema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const presetFilters: NormalizedFilter[] = [];
  const preferences: NonNullable<QueryRequest['preferences']> = [];
  let query = '';
  let limit = 10;

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    if (key === 'query' && typeof value === 'string') {
      query = value;
      continue;
    }
    if (key === 'limit' && typeof value === 'number') {
      limit = value;
      continue;
    }

    const minMatch = key.match(/^(.+)_min$/);
    if (minMatch?.[1]) {
      presetFilters.push({
        field: minMatch[1],
        op: 'gte',
        value: coerceFilterValue(value),
      });
      continue;
    }

    const maxMatch = key.match(/^(.+)_max$/);
    if (maxMatch?.[1]) {
      presetFilters.push({
        field: maxMatch[1],
        op: 'lte',
        value: coerceFilterValue(value),
      });
      continue;
    }

    if (key.startsWith('prefer_')) {
      const field = key.slice('prefer_'.length);
      const meta = readGatewayMeta(properties[key] ?? properties[field]);
      preferences.push({
        field,
        op: meta.match,
        value: coerceFilterValue(value),
        ...(meta.boost !== undefined ? { boost: meta.boost } : {}),
      });
      continue;
    }

    if (key in properties) {
      const meta = readGatewayMeta(properties[key]);
      const op: FilterOp =
        Array.isArray(value) && meta.match === 'eq'
          ? 'in'
          : Array.isArray(value) && meta.match === 'contains'
            ? 'containsAny'
            : meta.match;

      if (meta.asPreference) {
        preferences.push({
          field: key,
          op,
          value: coerceFilterValue(value),
          ...(meta.boost !== undefined ? { boost: meta.boost } : {}),
        });
      } else {
        presetFilters.push({
          field: key,
          op,
          value: coerceFilterValue(value),
        });
      }
    }
  }

  const trimmedQuery = query.trim();
  return {
    request: {
      entity: tool.entity,
      // Empty query is valid for tool invoke; structured args travel via presetFilters.
      ...(trimmedQuery ? { query: trimmedQuery } : {}),
      limit,
      useLlmFallback: false,
      ...(preferences.length > 0 ? { preferences } : {}),
    },
    presetFilters,
  };
}

function readGatewayMeta(property: Record<string, unknown> | undefined): {
  match: FilterOp;
  asPreference: boolean;
  boost?: number;
} {
  const gateway = (property?.['x-gateway'] ?? {}) as Record<string, unknown>;
  const matchRaw = typeof gateway.match === 'string' ? gateway.match : 'eq';
  const allowed: FilterOp[] = [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'contains',
    'containsAny',
    'containsAll',
  ];
  const match = allowed.includes(matchRaw as FilterOp) ? (matchRaw as FilterOp) : 'eq';
  return {
    match,
    asPreference: gateway.asPreference === true,
    ...(typeof gateway.boost === 'number' ? { boost: gateway.boost } : {}),
  };
}

function coerceFilterValue(
  value: unknown,
): string | number | boolean | Array<string | number | boolean> {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        return item;
      }
      return String(item);
    });
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
