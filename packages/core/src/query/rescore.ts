import { coerceToStringArray, fieldMatchesPreference } from '../mapping/apply.js';
import type { MappingField } from '../schemas/mapping.js';
import { getFieldRetrieval } from '../schemas/mapping.js';
import type { QueryPreference } from '../schemas/query.js';

export type RankingSignal = {
  field: string;
  op: string;
  value: string | number | boolean | Array<string | number | boolean>;
  boost: number;
  matched: boolean;
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

  const signalsById = new Map<string, RankingSignal[]>();
  const rescored = hits.map((hit) => {
    const signals: RankingSignal[] = [];
    let boostSum = 0;

    for (const preference of preferences) {
      const field = fieldsByName.get(preference.field);
      const retrieval = field ? getFieldRetrieval(field) : undefined;
      const boost = preference.boost ?? retrieval?.boost ?? 0.15;
      const matched = fieldMatchesPreference(
        hit.data,
        preference.field,
        preference.op,
        preference.value,
        retrieval,
      );
      signals.push({
        field: preference.field,
        op: preference.op,
        value: preference.value,
        boost,
        matched,
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
