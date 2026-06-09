import type { MappingField } from '../schemas/mapping.js';
import type { NormalizedFilter } from '../schemas/query.js';

export function shapeRecordData(
  data: Record<string, unknown>,
  fields: MappingField[],
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.visible || field.sensitive) continue;
    if (field.name in data) {
      shaped[field.name] = data[field.name];
    }
  }
  return shaped;
}

export function shapeAppliedFilters(
  filters: NormalizedFilter[],
  fields: MappingField[],
): NormalizedFilter[] {
  const sensitive = new Set(fields.filter((field) => field.sensitive).map((field) => field.name));
  return filters.filter((filter) => !sensitive.has(filter.field));
}

export function filterableFieldNames(fields: MappingField[]): Set<string> {
  return new Set(fields.filter((field) => field.filterable).map((field) => field.name));
}
