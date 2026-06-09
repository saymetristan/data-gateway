import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, RRF_K } from './rrf.js';

describe('reciprocalRankFusion', () => {
  it('prioriza ids que aparecen alto en ambas listas', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ]);

    expect(fused[0]?.id).toBe('a');
    expect(fused[1]?.id).toBe('b');
  });

  it('maneja listas disjuntas', () => {
    const fused = reciprocalRankFusion([['a', 'b'], ['c', 'd']]);
    expect(fused.map((item) => item.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('acumula score para ids repetidos en la misma lista', () => {
    const fused = reciprocalRankFusion([['a', 'a']]);
    const expected = 1 / (RRF_K + 1) + 1 / (RRF_K + 2);
    expect(fused[0]?.score).toBeCloseTo(expected, 6);
  });

  it('empata por id lexicográfico estable', () => {
    const fused = reciprocalRankFusion([['b'], ['a']]);
    const bScore = 1 / (RRF_K + 1);
    expect(fused[0]?.score).toBeCloseTo(bScore, 6);
    expect(fused[1]?.score).toBeCloseTo(bScore, 6);
  });
});
