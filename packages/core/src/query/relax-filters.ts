import type { MappingField } from '../schemas/mapping.js';
import type { NormalizedFilter, QueryPreference } from '../schemas/query.js';

export function filterKey(filter: NormalizedFilter): string {
  return `${filter.field}\0${filter.op}\0${JSON.stringify(filter.value)}`;
}

export type RelaxFiltersInput = {
  safeFilters: NormalizedFilter[];
  appliedPreferences: QueryPreference[];
  /** Extracted hard filters that came from implicit NL matches. */
  implicitFilters: NormalizedFilter[];
  /** Filters that must never be demoted (defaults, presets, request filters). */
  protectedFilters: NormalizedFilter[];
  fieldsByName: Map<string, MappingField>;
};

export type RelaxFiltersResult = {
  filters: NormalizedFilter[];
  preferences: QueryPreference[];
  demoted: NormalizedFilter[];
};

/**
 * Demote inferred (implicit) hard filters to soft preferences after a 0-hit retrieval.
 * Explicit / protected filters stay as hard constraints.
 */
export function buildRelaxedRetrievalState(input: RelaxFiltersInput): RelaxFiltersResult | null {
  const protectedKeys = new Set(input.protectedFilters.map(filterKey));
  const demoted = input.implicitFilters.filter((filter) => !protectedKeys.has(filterKey(filter)));
  if (demoted.length === 0) return null;

  const demoteKeys = new Set(demoted.map(filterKey));
  const filters = input.safeFilters.filter((filter) => !demoteKeys.has(filterKey(filter)));

  const preferences = [...input.appliedPreferences];
  const existingPrefKeys = new Set(
    preferences.map((preference) => filterKey({ field: preference.field, op: preference.op, value: preference.value })),
  );

  for (const filter of demoted) {
    const key = filterKey(filter);
    if (existingPrefKeys.has(key)) continue;
    const field = input.fieldsByName.get(filter.field);
    // Prefer explicit mapping boost; otherwise a moderate demotion boost.
    const boost = field?.retrieval?.boost ?? 0.25;
    preferences.push({
      field: filter.field,
      op: filter.op,
      value: filter.value,
      boost,
    });
    existingPrefKeys.add(key);
  }

  return { filters, preferences, demoted };
}
