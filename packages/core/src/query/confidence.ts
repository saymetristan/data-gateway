/**
 * Deterministic confidence in [0, 1] without LLM involvement.
 *
 * Linear blend of signals (weights sum to 1):
 * - scoreGap (0.25): relative gap between top-1 and top-2 RRF scores
 * - filterCoverage (0.15): fraction of requested/extracted filters that were applied
 * - lexicalOverlap (0.20): whether the top hit matched a lexical/tsquery branch
 * - distinctiveCoverage (0.25): fraction of distinctive query terms present in top hit
 * - resultFill (0.15): results.length / limit (capped at 1)
 *
 * Vector-only fallbacks (no lexical support) with poor distinctive coverage are
 * capped so weak semantic neighbors cannot look like strong matches.
 */
const WEIGHTS = {
  scoreGap: 0.25,
  filterCoverage: 0.15,
  lexicalOverlap: 0.2,
  distinctiveCoverage: 0.25,
  resultFill: 0.15,
} as const;

/** Soft ceiling when results came from vector-only with no distinctive term hit. */
const VECTOR_ONLY_WEAK_CAP = 0.42;

export type ConfidenceInput = {
  rankedScores: number[];
  requestedFilterCount: number;
  appliedFilterCount: number;
  topLexicalMatch: boolean;
  resultsCount: number;
  limit: number;
  /** 0–1 coverage of distinctive query terms in the top hit search text. */
  distinctiveTermCoverage?: number;
  /** True when the response had free text but zero lexical branch hits. */
  vectorOnlyFallback?: boolean;
};

export function computeConfidence(input: ConfidenceInput): number {
  const top = input.rankedScores[0] ?? 0;
  const second = input.rankedScores[1] ?? 0;
  const scoreGap =
    top <= 0 ? 0 : Math.min(1, Math.max(0, (top - second) / top));

  const filterCoverage =
    input.requestedFilterCount === 0
      ? 1
      : Math.min(1, input.appliedFilterCount / input.requestedFilterCount);

  const lexicalOverlap = input.topLexicalMatch ? 1 : 0;
  const distinctiveCoverage = clamp01(input.distinctiveTermCoverage ?? (input.topLexicalMatch ? 1 : 0));
  const resultFill =
    input.limit <= 0 ? 0 : Math.min(1, input.resultsCount / input.limit);

  const raw =
    WEIGHTS.scoreGap * scoreGap +
    WEIGHTS.filterCoverage * filterCoverage +
    WEIGHTS.lexicalOverlap * lexicalOverlap +
    WEIGHTS.distinctiveCoverage * distinctiveCoverage +
    WEIGHTS.resultFill * resultFill;

  let confidence = clamp01(raw);

  if (
    input.vectorOnlyFallback &&
    !input.topLexicalMatch &&
    distinctiveCoverage < 0.34
  ) {
    confidence = Math.min(confidence, VECTOR_ONLY_WEAK_CAP);
  }

  return confidence;
}

/**
 * Whether a search response is too weak to present as a hard success to agents.
 * Uses calibrated confidence — never absolute RRF score magnitude.
 */
export function isWeakSearchConfidence(confidence: number): boolean {
  return confidence < WEAK_SEARCH_CONFIDENCE_THRESHOLD;
}

export const WEAK_SEARCH_CONFIDENCE_THRESHOLD = 0.45;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(4));
}
