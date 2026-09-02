import { coerceToStringArray, fieldMatchesPreference } from '../mapping/apply.js';
import type { MappingField } from '../schemas/mapping.js';
import { getFieldRetrieval } from '../schemas/mapping.js';
import type { QueryPreference } from '../schemas/query.js';

export type RankingSignal = {
  field: string;
  boost: number;
  matched: boolean;
  matchedValues: QueryPreference['value'][];
};

export type RescoreInput = {
  id: string;
  score: number;
  data: Record<string, unknown>;
};

export type RescoreResult = {
  hits: RescoreInput[];
  signalsById: Map<string, RankingSignal[]>;
};

const MAX_TOTAL_BOOST = 0.75;

/**
 * Apply soft preference boosts after RRF.
 * final = base * (1 + min(sum(boosts), MAX_TOTAL_BOOST))
 */
export function applyPreferenceRescore(
  hits: RescoreInput[],
  preferences: QueryPreference[],
  fieldsByName: Map<string, MappingField>,
): RescoreResult {
  if (preferences.length === 0) {
    return { hits, signalsById: new Map() };
  }

  const preferencesByField = groupPreferencesByField(preferences);
  const signalsById = new Map<string, RankingSignal[]>();
  const rescored = hits.map((hit) => {
    const signals: RankingSignal[] = [];
    let boostSum = 0;

    for (const [fieldName, fieldPreferences] of preferencesByField) {
      const field = fieldsByName.get(fieldName);
      const retrieval = field ? getFieldRetrieval(field) : undefined;
      const matchedPreferences = fieldPreferences.filter((preference) =>
        fieldMatchesPreference(
          hit.data,
          preference.field,
          preference.op,
          preference.value,
          retrieval,
        ),
      );
      const matched = matchedPreferences.length > 0;
      // Values from the same field are alternatives (OR), not independent boosts.
      const boost = Math.max(
        0,
        ...matchedPreferences.map(
          (preference) => preference.boost ?? retrieval?.boost ?? 0.15,
        ),
      );
      signals.push({
        field: fieldName,
        boost,
        matched,
        matchedValues: matchedPreferences.map((preference) => preference.value),
      });
      if (matched) boostSum += boost;
    }

    signalsById.set(hit.id, signals);
    const capped = Math.min(boostSum, MAX_TOTAL_BOOST);
    return {
      ...hit,
      score: hit.score * (1 + capped),
    };
  });

  rescored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { hits: rescored, signalsById };
}

export function rankByPreferenceCoverage(
  hits: RescoreInput[],
  signalsById: Map<string, RankingSignal[]>,
): RescoreInput[] {
  return [...hits].sort((left, right) => {
    const leftCoverage = matchedFieldCount(signalsById.get(left.id));
    const rightCoverage = matchedFieldCount(signalsById.get(right.id));
    return (
      rightCoverage - leftCoverage ||
      right.score - left.score ||
      left.id.localeCompare(right.id)
    );
  });
}

export function hasAnyPreferenceMatch(
  hits: RescoreInput[],
  signalsById: Map<string, RankingSignal[]>,
): boolean {
  return hits.some((hit) => matchedFieldCount(signalsById.get(hit.id)) > 0);
}

function groupPreferencesByField(
  preferences: QueryPreference[],
): Map<string, QueryPreference[]> {
  const grouped = new Map<string, QueryPreference[]>();
  for (const preference of preferences) {
    grouped.set(preference.field, [
      ...(grouped.get(preference.field) ?? []),
      preference,
    ]);
  }
  return grouped;
}

function matchedFieldCount(signals: RankingSignal[] | undefined): number {
  return (signals ?? []).filter((signal) => signal.matched).length;
}

export function preferenceMatchesData(
  data: Record<string, unknown>,
  preference: QueryPreference,
  field?: MappingField,
): boolean {
  return fieldMatchesPreference(
    data,
    preference.field,
    preference.op,
    preference.value,
    field ? getFieldRetrieval(field) : undefined,
  );
}

export function summarizeSignals(
  signalsById: Map<string, RankingSignal[]>,
  topIds: string[],
): Array<{ id: string; matched: string[] }> {
  return topIds.map((id) => {
    const signals = signalsById.get(id) ?? [];
    return {
      id,
      matched: signals.filter((signal) => signal.matched).map((signal) => signal.field),
    };
  });
}

export function normalizePreferenceValues(
  value: QueryPreference['value'],
): Array<string | number | boolean> {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.includes(',')) {
    return coerceToStringArray(value);
  }
  return [value];
}
