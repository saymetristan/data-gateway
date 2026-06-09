/** Reciprocal Rank Fusion constant (Cormack et al.). */
export const RRF_K = 60;

export type RankedItem = {
  id: string;
  score: number;
};

/**
 * Fuses multiple ranked lists with RRF: score(id) = Σ 1 / (k + rank_i).
 * Each ranking is an ordered list of ids (best first). Duplicate ids across
 * lists accumulate score.
 */
export function reciprocalRankFusion(rankings: string[][], k = RRF_K): RankedItem[] {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const id = ranking[rank];
      if (!id) continue;
      const contribution = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
