import type { NormalizedFilter, QueryRequest } from '../schemas/query.js';
import type { ToolDefinition } from '../schemas/tools.js';

export type ToolQueryTranslation = {
  request: QueryRequest;
  presetFilters: NormalizedFilter[];
};

export function toolArgsToQuery(tool: ToolDefinition, args: Record<string, unknown>): ToolQueryTranslation {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const presetFilters: NormalizedFilter[] = [];
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

    if (key in properties) {
      presetFilters.push({
        field: key,
        op: 'eq',
        value: coerceFilterValue(value),
      });
    }
  }

  return {
    request: {
      entity: tool.entity,
      query: query.trim() || ' ',
      limit,
      useLlmFallback: false,
    },
    presetFilters,
  };
}

function coerceFilterValue(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
