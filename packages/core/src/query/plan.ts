import type { NormalizedFilter, QueryPreference } from '../schemas/query.js';

export type QueryPlanMatchSpan = {
  field: string;
  origin: 'explicit' | 'implicit';
  span: { start: number; end: number };
};

/**
 * Deterministic query plan produced before retrieval.
 * Structured args and explicit NL hints become hard filters; implicit matches
 * follow mapping/policy behavior; remaining text feeds lexical/vector search.
 */
export type QueryPlan = {
  hardFilters: NormalizedFilter[];
  preferences: QueryPreference[];
  remainingText: string;
  matchedSpans: QueryPlanMatchSpan[];
  warnings: string[];
};
