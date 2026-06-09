/**
 * Deterministic confidence in [0, 1] without LLM involvement.
 *
 * Linear blend of four signals (weights sum to 1):
 * - scoreGap (0.35): relative gap between top-1 and top-2 RRF scores
 * - filterCoverage (0.25): fraction of requested/extracted filters that were applied
 * - lexicalOverlap (0.25): whether the top hit matched the lexical/tsquery branch
 * - resultFill (0.15): results.length / limit (capped at 1)
 */
const WEIGHTS = {
  scoreGap: 0.35,
  filterCoverage: 0.25,
  lexicalOverlap: 0.25,
  resultFill: 0.15,
} as const;

export type ConfidenceInput = {
  rankedScores: number[];
  requestedFilterCount: number;
  appliedFilterCount: number;
  topLexicalMatch: boolean;
  resultsCount: number;
  limit: number;
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
  const resultFill =
    input.limit <= 0 ? 0 : Math.min(1, input.resultsCount / input.limit);

  const raw =
    WEIGHTS.scoreGap * scoreGap +
    WEIGHTS.filterCoverage * filterCoverage +
    WEIGHTS.lexicalOverlap * lexicalOverlap +
    WEIGHTS.resultFill * resultFill;

  return clamp01(raw);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(4));
}
