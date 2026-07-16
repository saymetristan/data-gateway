import type { NormalizedFilter, QueryPreference } from '../schemas/query.js';

/**
 * Build independent filter sets for preference-aware candidate retrieval.
 * Each preference is queried separately, so alternatives from the same field
 * behave as OR while base hard filters remain AND constraints.
 */
export function buildPreferenceCandidateFilterSets(
  baseFilters: NormalizedFilter[],
  preferences: QueryPreference[],
  filterableFields: Set<string>,
): NormalizedFilter[][] {
  const seen = new Set<string>();
  const sets: NormalizedFilter[][] = [];

  for (const preference of preferences) {
    if (!filterableFields.has(preference.field)) continue;
    const candidate: NormalizedFilter = {
      field: preference.field,
      op: preference.op,
      value: preference.value,
    };
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push([...baseFilters, candidate]);
  }

  return sets;
}
