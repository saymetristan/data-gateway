/** Reciprocal Rank Fusion constant (Cormack et al.). */
export const RRF_K = 60;

export type RankedItem = {
  id: string;
  score: number;
};

export type WeightedRanking = {
  ids: string[];
  weight?: number;
};

/**
 * Fuses multiple ranked lists with RRF: score(id) = Σ weight / (k + rank_i).
 * Each ranking is an ordered list of ids (best first). Duplicate ids across
 * lists accumulate score. Default weight is 1 for backwards compatibility.
 */
export function reciprocalRankFusion(
  rankings: string[][] | WeightedRanking[],
  k = RRF_K,
): RankedItem[] {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    const ids = Array.isArray(ranking) ? ranking : ranking.ids;
    const weight = Array.isArray(ranking) ? 1 : (ranking.weight ?? 1);
    for (let rank = 0; rank < ids.length; rank++) {
      const id = ids[rank];
      if (!id) continue;
      const contribution = weight / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
