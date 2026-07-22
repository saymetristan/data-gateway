import { describe, expect, it } from 'vitest';
import { resolveLexicalFusionWeight } from '../services/query.js';
import { buildLexicalBranches } from './lexical-branches.js';
import { selectLexicalBranches } from './retrieval.js';
import { reciprocalRankFusion } from './rrf.js';

describe('selectLexicalBranches', () => {
  it('keeps the full branch and highest-weight distinctive/synonym branches', () => {
    const branches = buildLexicalBranches(
      'tela para bordar punto de cruz, Aida o canevá, manualidades',
      { aida: ['cuadrille aida', 'cuadrille'], caneva: ['etamina'] },
    );
    const selected = selectLexicalBranches(branches);
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.some((branch) => branch.kind === 'full')).toBe(true);
    expect(selected.some((branch) => /aida/i.test(branch.text))).toBe(true);
  });
});

describe('multi-branch RRF preference for distinctive hits', () => {
  it('lets a distinctive-term ranking outrank a weak full-phrase empty/error path', () => {
    // Full phrase matched nothing; distinctive "Aida" matched catalog rows.
    const fused = reciprocalRankFusion([
      { ids: [], weight: 1 },
      { ids: ['aida-1', 'aida-2'], weight: 1.5 },
      { ids: ['aros-1', 'navidad-1'], weight: 1.1 },
    ]);
    expect(fused[0]?.id).toBe('aida-1');
  });

  it('boosts lexical fusion weight when distinctive terms hit', () => {
    const boosted = resolveLexicalFusionWeight(
      1,
      [{ search_source: 'Cuadrille Aida Blanco' }],
      ['Aida'],
    );
    expect(boosted).toBeGreaterThanOrEqual(1.45);

    const plain = resolveLexicalFusionWeight(
      1,
      [{ search_source: 'Algodón Navidad Digital' }],
      ['Aida'],
    );
    expect(plain).toBe(1);
  });
});
